const BASE='https://my.meteoblue.com/packages/basic-1h';

function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}

module.exports=async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=900, stale-while-revalidate=1800');
  const lat=num(req.query.lat),lon=num(req.query.lon);
  if(lat===null||lon===null||Math.abs(lat)>90||Math.abs(lon)>180)return res.status(400).json({error:'Coordenadas no válidas'});
  const apikey=process.env.METEOBLUE_API_KEY;
  if(!apikey)return res.status(503).json({configured:false,error:'meteoblue no configurado'});
  try{
    const u=new URL(BASE);
    u.searchParams.set('lat',String(lat));
    u.searchParams.set('lon',String(lon));
    u.searchParams.set('format','json');
    u.searchParams.set('apikey',apikey);
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),7500);
    let r;
    try{r=await fetch(u,{headers:{Accept:'application/json','User-Agent':'Huracan-PWA/3.1'},signal:ctrl.signal});}
    finally{clearTimeout(timer);}
    if(!r.ok)throw new Error(`meteoblue ${r.status} ${r.statusText}`);
    const j=await r.json();
    const d=j?.data_1h||{};
    if(!Array.isArray(d.time)||!d.time.length)throw new Error('Respuesta meteoblue sin datos horarios');
    res.status(200).json({
      configured:true,
      source:'meteoblue',
      metadata:j?.metadata||null,
      units:j?.units||null,
      hourly:{
        time:d.time,
        temperature:d.temperature||[],
        apparent_temperature:d.felttemperature||[],
        precipitation:d.precipitation||[],
        precipitation_probability:d.precipitation_probability||[],
        windspeed:d.windspeed||[],
        relativehumidity:d.relativehumidity||[],
        sealevelpressure:d.sealevelpressure||[]
      }
    });
  }catch(err){
    console.error('meteoblue proxy',err);
    res.status(502).json({configured:true,error:'No se pudieron obtener datos de meteoblue',detail:err?.message||String(err)});
  }
};
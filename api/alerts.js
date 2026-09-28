const FEED_URL='https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAE_wah_RSS.xml';

async function fetchText(url,timeout=9000){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeout);
  try{
    const r=await fetch(url,{headers:{Accept:'application/xml,text/xml,*/*','User-Agent':'Tiempo-PWA/1.0'},signal:ctrl.signal});
    if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
    return await r.text();
  }finally{clearTimeout(timer);}
}
function decodeXml(s=''){
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&#(x?[0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10))).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').trim();
}
function tag(xml,name){const m=String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i'));return m?decodeXml(m[1]):'';}
function blocks(xml,name){return [...String(xml).matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`,'gi'))].map(m=>m[0]);}
function params(info){
  const out={};
  for(const p of blocks(info,'parameter')){const k=tag(p,'valueName');const v=tag(p,'value');if(k)out[k]=v;}
  return out;
}
function normalizeLevel(v=''){
  const s=String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(s.includes('rojo')||s.includes('extreme'))return'rojo';
  if(s.includes('naranja')||s.includes('severe'))return'naranja';
  if(s.includes('amarillo')||s.includes('moderate'))return'amarillo';
  return'';
}
function parsePolygon(text=''){
  return String(text).trim().split(/\s+/).map(pair=>{const [lat,lon]=pair.split(',').map(Number);return[lon,lat];}).filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1]));
}
function pointInPolygon(lon,lat,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const [xi,yi]=poly[i],[xj,yj]=poly[j];
    const hit=((yi>lat)!==(yj>lat))&&(lon<(xj-xi)*(lat-yi)/((yj-yi)||1e-12)+xi);
    if(hit)inside=!inside;
  }
  return inside;
}
function spanishInfo(xml){
  const infos=blocks(xml,'info');
  return infos.find(x=>/^es(?:-|$)/i.test(tag(x,'language')))||infos.find(x=>!tag(x,'language'))||infos[0]||'';
}
function parseAlert(xml,lat,lon,sourceUrl){
  const info=spanishInfo(xml); if(!info)return null;
  let matchedArea='';
  let matched=false;
  for(const area of blocks(info,'area')){
    const polygons=blocks(area,'polygon').map(p=>parsePolygon(tag(p,'polygon'))).filter(p=>p.length>=3);
    if(polygons.some(poly=>pointInPolygon(lon,lat,poly))){matched=true;matchedArea=tag(area,'areaDesc');break;}
  }
  if(!matched)return null;
  const p=params(info);
  const level=normalizeLevel(p['AEMET-Meteoalerta nivel']||tag(info,'severity'));
  if(!level)return null;
  const onset=tag(info,'onset')||tag(info,'effective');
  const expires=tag(info,'expires');
  const now=Date.now();
  if(expires&&Date.parse(expires)<now-5*60*1000)return null;
  const parameter=p['AEMET-Meteoalerta parametro']||'';
  const parts=parameter.split(';').map(x=>x.trim()).filter(Boolean);
  const detail=parts.length>1?parts.slice(1).join(' · '):parameter;
  return{
    level,
    event:tag(info,'event')||p['AEMET-Meteoalerta fenomeno']||'Fenómeno adverso',
    headline:tag(info,'headline'),
    area:matchedArea,
    onset,
    expires,
    probability:p['AEMET-Meteoalerta probabilidad']||p['AEMET-Meteoalerta probabilidad de ocurrencia']||'',
    detail,
    description:tag(info,'description'),
    web:tag(info,'web')||'https://www.aemet.es/es/eltiempo/prediccion/avisos',
    sourceUrl
  };
}
function extractLinks(feed){
  const links=[];
  for(const item of blocks(feed,'item')){const link=tag(item,'link');if(/^https?:\/\/.*\.xml(?:\?.*)?$/i.test(link))links.push(link);}
  return [...new Set(links)];
}
function levelRank(x){return x==='rojo'?3:x==='naranja'?2:x==='amarillo'?1:0;}

module.exports=async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=900');
  const lat=Number(req.query?.lat),lon=Number(req.query?.lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<-90||lat>90||lon<-180||lon>180)return res.status(400).json({error:'Coordenadas no válidas'});
  try{
    const feed=await fetchText(FEED_URL);
    const links=extractLinks(feed).slice(0,120);
    const results=await Promise.allSettled(links.map(async url=>parseAlert(await fetchText(url,7000),lat,lon,url)));
    const alerts=results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
    const unique=[];const seen=new Set();
    for(const a of alerts){const key=[a.level,a.event,a.area,a.onset,a.expires].join('|');if(!seen.has(key)){seen.add(key);unique.push(a);}}
    unique.sort((a,b)=>levelRank(b.level)-levelRank(a.level)||(Date.parse(a.onset||0)-Date.parse(b.onset||0)));
    res.status(200).json({source:'AEMET Meteoalerta',generatedAt:new Date().toISOString(),alerts:unique.slice(0,8)});
  }catch(err){console.error(err);res.status(502).json({error:'No se pudieron consultar los avisos de AEMET',detail:err?.message||String(err)});}
};

module.exports._test={decodeXml,tag,blocks,normalizeLevel,parsePolygon,pointInPolygon,parseAlert,extractLinks};

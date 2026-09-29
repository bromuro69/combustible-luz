const zlib = require('zlib');

const BASE = 'https://api.open-meteo.com/v1';
const ENSEMBLE = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const RAINVIEWER = 'https://api.rainviewer.com/public/weather-maps.json';

function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function num(v){ const n=Number(v); return Number.isFinite(n)?n:null; }
function mean(values){ const a=values.filter(Number.isFinite); return a.length?a.reduce((s,v)=>s+v,0)/a.length:null; }
function std(values){ const m=mean(values); if(m===null)return null; const a=values.filter(Number.isFinite); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length); }
function weighted(items){ const a=items.filter(x=>Number.isFinite(x?.value)&&Number.isFinite(x?.weight)&&x.weight>0); const w=a.reduce((s,x)=>s+x.weight,0); return w?a.reduce((s,x)=>s+x.value*x.weight,0)/w:null; }

async function fetchJson(url, timeout=7000){
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout);
  try{ const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Tiempo-PWA/2.0'},signal:ctrl.signal}); if(!r.ok)throw new Error(`${r.status} ${r.statusText}`); return await r.json(); }
  finally{ clearTimeout(timer); }
}
async function fetchBuffer(url, timeout=6000){
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout);
  try{ const r=await fetch(url,{headers:{Accept:'image/png','User-Agent':'Tiempo-PWA/2.0'},signal:ctrl.signal}); if(!r.ok)throw new Error(`${r.status}`); return Buffer.from(await r.arrayBuffer()); }
  finally{ clearTimeout(timer); }
}
function qs(obj){ const q=new URLSearchParams(); for(const [k,v] of Object.entries(obj)){ if(v!==undefined&&v!==null&&v!=='')q.set(k,String(v)); } return q.toString(); }

function baseForecastUrl(lat,lon){
  return `${BASE}/forecast?${qs({
    latitude:lat,longitude:lon,timezone:'auto',forecast_days:7,
    current:'temperature_2m,apparent_temperature,is_day,weather_code,cloud_cover,wind_speed_10m,precipitation',
    hourly:'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,is_day,wind_speed_10m,cloud_cover,cape,lightning_potential,thunderstorm_probability',
    daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max'
  })}`;
}
function providerUrl(provider,lat,lon){
  return `${BASE}/${provider}?${qs({
    latitude:lat,longitude:lon,timezone:'auto',forecast_days:3,
    current:'temperature_2m,weather_code',
    hourly:'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,cloud_cover'
  })}`;
}
function highResUrl(model,lat,lon){
  return `${BASE}/forecast?${qs({
    latitude:lat,longitude:lon,timezone:'auto',forecast_days:3,models:model,
    hourly:'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,cloud_cover'
  })}`;
}
function ensembleUrl(model,lat,lon){
  return `${ENSEMBLE}?${qs({latitude:lat,longitude:lon,timezone:'auto',forecast_days:3,models:model,hourly:'temperature_2m,precipitation,wind_speed_10m'})}`;
}

function timeIndex(data,time){ return Array.isArray(data?.hourly?.time)?data.hourly.time.indexOf(time):-1; }
function hourlyValue(data,time,key){ const i=timeIndex(data,time); if(i<0)return null; return num(data.hourly?.[key]?.[i]); }
function ensembleMembers(data,time,key){
  const i=timeIndex(data,time); if(i<0)return [];
  const h=data.hourly||{};
  return Object.keys(h).filter(k=>k===key||k.startsWith(`${key}_member`)).map(k=>num(h[k]?.[i])).filter(Number.isFinite);
}
function ensembleRainProbability(data,time,threshold=0.1){ const a=ensembleMembers(data,time,'precipitation'); return a.length?100*a.filter(v=>v>=threshold).length/a.length:null; }
function ensembleSpread(data,time,key){ const a=ensembleMembers(data,time,key); return a.length?std(a):null; }

function paeth(a,b,c){ const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c); return pa<=pb&&pa<=pc?a:pb<=pc?b:c; }
function decodePng(buf){
  const sig='89504e470d0a1a0a'; if(buf.subarray(0,8).toString('hex')!==sig)throw new Error('png');
  let p=8,w,h,bitDepth,colorType,interlace,idats=[];
  while(p+8<=buf.length){ const len=buf.readUInt32BE(p); const type=buf.toString('ascii',p+4,p+8); const data=buf.subarray(p+8,p+8+len); p+=12+len;
    if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);bitDepth=data[8];colorType=data[9];interlace=data[12];}
    else if(type==='IDAT')idats.push(data); else if(type==='IEND')break;
  }
  if(bitDepth!==8||interlace!==0||![2,6].includes(colorType))throw new Error('png-format');
  const bpp=colorType===6?4:3; const raw=zlib.inflateSync(Buffer.concat(idats)); const stride=w*bpp; const out=Buffer.alloc(h*stride); let rp=0;
  for(let y=0;y<h;y++){
    const filter=raw[rp++];
    for(let x=0;x<stride;x++){
      const v=raw[rp++], left=x>=bpp?out[y*stride+x-bpp]:0, up=y?out[(y-1)*stride+x]:0, ul=y&&x>=bpp?out[(y-1)*stride+x-bpp]:0;
      let val=v;
      if(filter===1)val=(v+left)&255; else if(filter===2)val=(v+up)&255; else if(filter===3)val=(v+Math.floor((left+up)/2))&255; else if(filter===4)val=(v+paeth(left,up,ul))&255; else if(filter!==0)throw new Error('png-filter');
      out[y*stride+x]=val;
    }
  }
  return {width:w,height:h,bpp,pixels:out,colorType};
}
function pixelAlpha(img,x,y){ if(x<0||y<0||x>=img.width||y>=img.height)return 0; if(img.colorType===6)return img.pixels[(y*img.width+x)*4+3]; const i=(y*img.width+x)*3; return (img.pixels[i]+img.pixels[i+1]+img.pixels[i+2])>20?255:0; }
function analyzeRadarImage(img){
  const cx=Math.floor(img.width/2),cy=Math.floor(img.height/2); let centerMax=0,nearest=Infinity,wet=0;
  for(let y=0;y<img.height;y+=2){ for(let x=0;x<img.width;x+=2){ const a=pixelAlpha(img,x,y); if(a>=32){ wet++; const d=Math.hypot(x-cx,y-cy); if(d<nearest)nearest=d; } } }
  for(let y=cy-3;y<=cy+3;y++)for(let x=cx-3;x<=cx+3;x++)centerMax=Math.max(centerMax,pixelAlpha(img,x,y));
  return {centerAlpha:centerMax,nearestPx:Number.isFinite(nearest)?nearest:null,wetPixels:wet};
}
function regressionSlope(points){
  if(points.length<3)return null; const mx=mean(points.map(p=>p.x)),my=mean(points.map(p=>p.y)); let den=0,numr=0; for(const p of points){den+=(p.x-mx)**2;numr+=(p.x-mx)*(p.y-my);} return den?numr/den:null;
}
async function getRadarNowcast(lat,lon){
  try{
    const meta=await fetchJson(RAINVIEWER,5000); const frames=(meta?.radar?.past||[]).slice(-6); if(frames.length<2)return {available:false};
    const zoom=7,size=256,color=2,options='0_0';
    const settled=await Promise.allSettled(frames.map(f=>fetchBuffer(`${meta.host}${f.path}/${size}/${zoom}/${lat}/${lon}/${color}/${options}.png`,5000).then(b=>({time:f.time,...analyzeRadarImage(decodePng(b))}))));
    const samples=settled.filter(x=>x.status==='fulfilled').map(x=>x.value).sort((a,b)=>a.time-b.time); if(samples.length<2)return {available:false};
    const latest=samples[samples.length-1]; const kmPerPx=Math.cos(Number(lat)*Math.PI/180)*156543.03392/(2**zoom)/1000;
    const raining=latest.centerAlpha>=32; const finite=samples.filter(s=>Number.isFinite(s.nearestPx)); let arrivalMinutes=null,trend='stable';
    if(!raining&&finite.length>=3){ const t0=finite[0].time; const points=finite.map(s=>({x:(s.time-t0)/60,y:s.nearestPx})); const slope=regressionSlope(points); if(Number.isFinite(slope)){ if(slope<-0.03)trend='approaching'; else if(slope>0.03)trend='moving-away'; if(slope<-0.05&&latest.nearestPx!==null){ const eta=latest.nearestPx/(-slope); if(eta>=0&&eta<=180)arrivalMinutes=Math.round(eta); } } }
    const nearbyKm=latest.nearestPx===null?null:Math.round(latest.nearestPx*kmPerPx*10)/10;
    return {available:true,source:'RainViewer',generatedAt:new Date((meta.generated||latest.time)*1000).toISOString(),frames:samples.length,raining,centerAlpha:latest.centerAlpha,nearbyKm,trend,arrivalMinutes};
  }catch(e){ return {available:false,error:e?.message||String(e)}; }
}

function clone(o){ return JSON.parse(JSON.stringify(o)); }
function recomputeDaily(out){
  const h=out.hourly||{}, d=out.daily||{}; if(!Array.isArray(d.time)||!Array.isArray(h.time))return;
  d.time.forEach((date,di)=>{
    const idx=h.time.map((t,i)=>t.startsWith(date)?i:-1).filter(i=>i>=0); if(!idx.length)return;
    const probs=idx.map(i=>num(h.precipitation_probability?.[i])).filter(Number.isFinite); const prec=idx.map(i=>num(h.precipitation?.[i])).filter(Number.isFinite); const temps=idx.map(i=>num(h.temperature_2m?.[i])).filter(Number.isFinite); const winds=idx.map(i=>num(h.wind_speed_10m?.[i])).filter(Number.isFinite);
    if(probs.length)d.precipitation_probability_max[di]=Math.round(Math.max(...probs));
    if(prec.length)d.precipitation_sum[di]=Math.round(prec.reduce((s,v)=>s+v,0)*10)/10;
    if(temps.length){d.temperature_2m_max[di]=Math.round(Math.max(...temps)*10)/10;d.temperature_2m_min[di]=Math.round(Math.min(...temps)*10)/10;}
    if(winds.length)d.wind_speed_10m_max[di]=Math.round(Math.max(...winds)*10)/10;
  });
}

function applySmartFusion(base, deterministic, ensembles, radar, customWeights={}){
  const out=clone(base), times=out.hourly?.time||[]; const nowIndex=Math.max(0,times.findIndex(t=>t>=out.current?.time)); const confScores=[], training=[];
  const providerWeights={ecmwf:customWeights.ecmwf??0.42,icon:customWeights.icon??0.28,gfs:customWeights.gfs??0.18,highres:customWeights.highres??0.12};
  const rainWeights={ecmwf:customWeights.rainEcmwf??0.50,icon:customWeights.rainIcon??0.30,gfs:customWeights.rainGfs??0.20};
  for(let i=0;i<times.length;i++){
    const t=times[i], hoursAhead=Math.max(0,i-nowIndex);
    const baseTemp=num(base.hourly?.temperature_2m?.[i]),baseFeels=num(base.hourly?.apparent_temperature?.[i]),basePrec=num(base.hourly?.precipitation?.[i]),baseProb=num(base.hourly?.precipitation_probability?.[i]),baseWind=num(base.hourly?.wind_speed_10m?.[i]);
    const detItems=[];
    for(const m of deterministic){ const weight=providerWeights[m.kind]||0.1; detItems.push({m,weight}); }
    const detTemp=weighted(detItems.map(x=>({value:hourlyValue(x.m.data,t,'temperature_2m'),weight:x.weight})));
    const detFeels=weighted(detItems.map(x=>({value:hourlyValue(x.m.data,t,'apparent_temperature'),weight:x.weight})));
    const detPrec=weighted(detItems.map(x=>({value:hourlyValue(x.m.data,t,'precipitation'),weight:x.weight})));
    const detWind=weighted(detItems.map(x=>({value:hourlyValue(x.m.data,t,'wind_speed_10m'),weight:x.weight})));
    if(Number.isFinite(baseTemp)&&Number.isFinite(detTemp))out.hourly.temperature_2m[i]=Math.round((baseTemp*.58+detTemp*.42)*10)/10;
    if(Number.isFinite(baseFeels)&&Number.isFinite(detFeels))out.hourly.apparent_temperature[i]=Math.round((baseFeels*.6+detFeels*.4)*10)/10;
    if(Number.isFinite(basePrec)&&Number.isFinite(detPrec))out.hourly.precipitation[i]=Math.max(0,Math.round((basePrec*.55+detPrec*.45)*100)/100);
    if(Number.isFinite(baseWind)&&Number.isFinite(detWind))out.hourly.wind_speed_10m[i]=Math.max(0,Math.round((baseWind*.6+detWind*.4)*10)/10);

    const ensProbItems=ensembles.map(e=>({kind:e.kind,value:ensembleRainProbability(e.data,t,.1),weight:rainWeights[e.kind]||0.2})).filter(x=>Number.isFinite(x.value));
    const ensProbs=ensProbItems.map(x=>x.value); const ensProb=weighted(ensProbItems);
    if(Number.isFinite(baseProb)&&Number.isFinite(ensProb))out.hourly.precipitation_probability[i]=Math.round(clamp(baseProb*.4+ensProb*.6,0,100));
    else if(Number.isFinite(ensProb))out.hourly.precipitation_probability[i]=Math.round(ensProb);

    if(hoursAhead<=2&&radar?.available){
      let p=num(out.hourly.precipitation_probability?.[i])||0;
      if(radar.raining){ p=Math.max(p,hoursAhead===0?95:hoursAhead===1?88:75); }
      else if(Number.isFinite(radar.arrivalMinutes)){
        const etaH=radar.arrivalMinutes/60; const delta=Math.abs(hoursAhead-etaH); if(delta<=.75)p=Math.max(p,etaH<=1?82:72);
      } else if((radar.nearbyKm===null||radar.nearbyKm>35)&&p<70){ p*=.85; }
      out.hourly.precipitation_probability[i]=Math.round(clamp(p,0,100));
    }
    const stormProb=num(base.hourly?.thunderstorm_probability?.[i]);
    if(Number.isFinite(stormProb)&&stormProb>=30){out.hourly.precipitation_probability[i]=Math.max(num(out.hourly.precipitation_probability?.[i])||0,Math.round(stormProb*.8));}

    if(hoursAhead<24){
      const detTrain={},rainTrain={};
      deterministic.forEach(m=>{const tv=hourlyValue(m.data,t,'temperature_2m');if(Number.isFinite(tv))detTrain[m.kind]=Math.round(tv*10)/10;});
      ensProbItems.forEach(x=>{rainTrain[x.kind]=Math.round(x.value);});
      training.push({time:t,temp:detTrain,rainProb:rainTrain});
      const agreement=ensProbs.length>=2?clamp(100-(std(ensProbs)||0)*1.5,0,100):55;
      const certainty=Number.isFinite(ensProb)?Math.abs(ensProb-50)*2:50;
      const spreadTemps=ensembles.map(e=>ensembleSpread(e.data,t,'temperature_2m')).filter(Number.isFinite); const tempPenalty=spreadTemps.length?clamp((mean(spreadTemps)||0)*8,0,25):10;
      let score=agreement*.58+certainty*.42-tempPenalty;
      if(hoursAhead<=2&&radar?.available)score=score*.75+25;
      confScores.push(clamp(score,0,100));
    }
  }
  recomputeDaily(out);
  const score=Math.round(mean(confScores)||55); const level=score>=75?'high':score>=50?'medium':'low';
  return {forecast:out, confidence:{score,level,label:level==='high'?'alta':level==='medium'?'media':'baja'},training};
}

module.exports = async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=600');
  const lat=num(req.query.lat),lon=num(req.query.lon); if(lat===null||lon===null||Math.abs(lat)>90||Math.abs(lon)>180)return res.status(400).json({error:'Coordenadas no válidas'});
  try{
    const jobs=[
      fetchJson(baseForecastUrl(lat,lon),8000),
      fetchJson(providerUrl('ecmwf',lat,lon),8000),
      fetchJson(providerUrl('dwd-icon',lat,lon),8000),
      fetchJson(providerUrl('gfs',lat,lon),8000),
      fetchJson(highResUrl('italia_meteo_arpae_icon_2i',lat,lon),7000),
      fetchJson(ensembleUrl('ecmwf_ifs025',lat,lon),9000),
      fetchJson(ensembleUrl('icon_seamless',lat,lon),9000),
      fetchJson(ensembleUrl('gfs_seamless',lat,lon),9000),
      getRadarNowcast(lat,lon)
    ];
    const settled=await Promise.allSettled(jobs); if(settled[0].status!=='fulfilled')throw settled[0].reason;
    const base=settled[0].value; const deterministic=[]; if(settled[1].status==='fulfilled')deterministic.push({kind:'ecmwf',data:settled[1].value}); if(settled[2].status==='fulfilled')deterministic.push({kind:'icon',data:settled[2].value}); if(settled[3].status==='fulfilled')deterministic.push({kind:'gfs',data:settled[3].value}); if(settled[4].status==='fulfilled')deterministic.push({kind:'highres',data:settled[4].value});
    const ensembles=[]; [['ecmwf',5],['icon',6],['gfs',7]].forEach(([kind,idx])=>{if(settled[idx].status==='fulfilled')ensembles.push({kind,data:settled[idx].value});});
    const radar=settled[8].status==='fulfilled'?settled[8].value:{available:false};
    const qWeight=(name,def)=>{const v=num(req.query[name]);return v===null?def:clamp(v,0.03,0.85);};
    const customWeights={ecmwf:qWeight('we',0.42),icon:qWeight('wi',0.28),gfs:qWeight('wg',0.18),highres:qWeight('wh',0.12),rainEcmwf:qWeight('re',0.50),rainIcon:qWeight('ri',0.30),rainGfs:qWeight('rg',0.20)};
    const fused=applySmartFusion(base,deterministic,ensembles,radar,customWeights);
    res.status(200).json({generatedAt:new Date().toISOString(),forecast:fused.forecast,confidence:fused.confidence,smart:{deterministicSources:deterministic.map(x=>x.kind),ensembleSources:ensembles.map(x=>x.kind),radar,training:fused.training,weights:customWeights,engine:'weighted-multimodel-ensemble-radar-learning-v2'}});
  }catch(err){ console.error('smart forecast',err); res.status(502).json({error:'No se pudo generar la previsión inteligente',detail:err?.message||String(err)}); }
};

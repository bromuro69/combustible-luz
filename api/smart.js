const zlib = require('zlib');

const BASE = 'https://api.open-meteo.com/v1';
const ENSEMBLE = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const SINGLE_RUN = 'https://single-runs-api.open-meteo.com/v1/forecast';
const RAINVIEWER = 'https://api.rainviewer.com/public/weather-maps.json';

function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function num(v){ const n=Number(v); return Number.isFinite(n)?n:null; }
function mean(values){ const a=values.filter(Number.isFinite); return a.length?a.reduce((s,v)=>s+v,0)/a.length:null; }
function std(values){ const m=mean(values); if(m===null)return null; const a=values.filter(Number.isFinite); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length); }
function weighted(items){ const a=items.filter(x=>Number.isFinite(x?.value)&&Number.isFinite(x?.weight)&&x.weight>0); const w=a.reduce((s,x)=>s+x.weight,0); return w?a.reduce((s,x)=>s+x.value*x.weight,0)/w:null; }
function qs(obj){ const q=new URLSearchParams(); for(const [k,v] of Object.entries(obj)){ if(v!==undefined&&v!==null&&v!=='')q.set(k,String(v)); } return q.toString(); }

async function fetchJson(url, timeout=7000){
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout);
  try{
    const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Huracan-PWA/3.0'},signal:ctrl.signal});
    if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function fetchBuffer(url, timeout=6000){
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout);
  try{
    const r=await fetch(url,{headers:{Accept:'image/png','User-Agent':'Huracan-PWA/3.0'},signal:ctrl.signal});
    if(!r.ok)throw new Error(`${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(timer); }
}

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
    latitude:lat,longitude:lon,timezone:'auto',forecast_days:4,
    current:'temperature_2m,weather_code',
    hourly:'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,cloud_cover'
  })}`;
}
function ensembleUrl(model,lat,lon){
  return `${ENSEMBLE}?${qs({latitude:lat,longitude:lon,timezone:'auto',forecast_days:7,models:model,hourly:'temperature_2m,precipitation'})}`;
}
function runIso(ms){ return new Date(ms).toISOString().slice(0,13)+':00'; }
function likelyAvailableEcmwfRuns(){
  const lagged=Date.now()-7*3600e3;
  const d=new Date(lagged); const cycle=Math.floor(d.getUTCHours()/6)*6;
  const base=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),cycle,0,0,0);
  return [base,base-6*3600e3].map(runIso);
}
function singleRunUrl(run,lat,lon){
  return `${SINGLE_RUN}?${qs({
    latitude:lat,longitude:lon,timezone:'auto',forecast_days:4,models:'ecmwf_ifs025',run,
    hourly:'temperature_2m,precipitation'
  })}`;
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
  while(p+8<=buf.length){
    const len=buf.readUInt32BE(p),type=buf.toString('ascii',p+4,p+8),data=buf.subarray(p+8,p+8+len); p+=12+len;
    if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);bitDepth=data[8];colorType=data[9];interlace=data[12];}
    else if(type==='IDAT')idats.push(data); else if(type==='IEND')break;
  }
  if(bitDepth!==8||interlace!==0||![2,6].includes(colorType))throw new Error('png-format');
  const bpp=colorType===6?4:3,raw=zlib.inflateSync(Buffer.concat(idats)),stride=w*bpp,out=Buffer.alloc(h*stride); let rp=0;
  for(let y=0;y<h;y++){
    const filter=raw[rp++];
    for(let x=0;x<stride;x++){
      const v=raw[rp++],left=x>=bpp?out[y*stride+x-bpp]:0,up=y?out[(y-1)*stride+x]:0,ul=y&&x>=bpp?out[(y-1)*stride+x-bpp]:0;
      let val=v;
      if(filter===1)val=(v+left)&255; else if(filter===2)val=(v+up)&255; else if(filter===3)val=(v+Math.floor((left+up)/2))&255; else if(filter===4)val=(v+paeth(left,up,ul))&255; else if(filter!==0)throw new Error('png-filter');
      out[y*stride+x]=val;
    }
  }
  return {width:w,height:h,bpp,pixels:out,colorType};
}
function pixelAlpha(img,x,y){
  if(x<0||y<0||x>=img.width||y>=img.height)return 0;
  if(img.colorType===6)return img.pixels[(y*img.width+x)*4+3];
  const i=(y*img.width+x)*3; return (img.pixels[i]+img.pixels[i+1]+img.pixels[i+2])>20?255:0;
}
function analyzeRadarImage(img){
  const cx=Math.floor(img.width/2),cy=Math.floor(img.height/2); let centerMax=0,nearest=Infinity,wet=0;
  for(let y=0;y<img.height;y+=2)for(let x=0;x<img.width;x+=2){
    const a=pixelAlpha(img,x,y); if(a>=32){wet++;const d=Math.hypot(x-cx,y-cy);if(d<nearest)nearest=d;}
  }
  for(let y=cy-3;y<=cy+3;y++)for(let x=cx-3;x<=cx+3;x++)centerMax=Math.max(centerMax,pixelAlpha(img,x,y));
  return {centerAlpha:centerMax,nearestPx:Number.isFinite(nearest)?nearest:null,wetPixels:wet};
}
function regressionSlope(points){
  if(points.length<3)return null;
  const mx=mean(points.map(p=>p.x)),my=mean(points.map(p=>p.y)); let den=0,n=0;
  for(const p of points){den+=(p.x-mx)**2;n+=(p.x-mx)*(p.y-my);} return den?n/den:null;
}
async function getRadarNowcast(lat,lon){
  try{
    const meta=await fetchJson(RAINVIEWER,5000),frames=(meta?.radar?.past||[]).slice(-6); if(frames.length<2)return {available:false};
    const zoom=7,size=256,color=2,options='0_0';
    const settled=await Promise.allSettled(frames.map(f=>fetchBuffer(`${meta.host}${f.path}/${size}/${zoom}/${lat}/${lon}/${color}/${options}.png`,4500).then(b=>({time:f.time,...analyzeRadarImage(decodePng(b))}))));
    const samples=settled.filter(x=>x.status==='fulfilled').map(x=>x.value).sort((a,b)=>a.time-b.time); if(samples.length<2)return {available:false};
    const latest=samples[samples.length-1],kmPerPx=Math.cos(Number(lat)*Math.PI/180)*156543.03392/(2**zoom)/1000;
    const distanceSeries=samples.filter(s=>s.nearestPx!==null).map(s=>({x:(s.time-samples[0].time)/60,y:s.nearestPx*kmPerPx}));
    const slope=regressionSlope(distanceSeries); let trend='unknown';
    if(Number.isFinite(slope)){if(slope<=-0.05)trend='approaching';else if(slope>=0.05)trend='receding';else trend='steady';}
    const nearbyKm=latest.nearestPx===null?null:Math.round(latest.nearestPx*kmPerPx*10)/10;
    return {
      available:true,source:'RainViewer',generatedAt:new Date((meta.generated||latest.time)*1000).toISOString(),frames:samples.length,
      raining:latest.centerAlpha>=32,centerAlpha:latest.centerAlpha,nearbyKm,trend,
      distanceTrendKmPerMin:Number.isFinite(slope)?Math.round(slope*1000)/1000:null
    };
  }catch(e){ return {available:false,error:e?.message||String(e)}; }
}

function clone(o){ return JSON.parse(JSON.stringify(o)); }
function recomputeDaily(out){
  const h=out.hourly||{},d=out.daily||{}; if(!Array.isArray(d.time)||!Array.isArray(h.time))return;
  d.time.forEach((date,di)=>{
    const idx=[];h.time.forEach((t,i)=>{if(String(t).startsWith(date))idx.push(i);});if(!idx.length)return;
    const probs=idx.map(i=>num(h.precipitation_probability?.[i])).filter(Number.isFinite),prec=idx.map(i=>num(h.precipitation?.[i])).filter(Number.isFinite),temps=idx.map(i=>num(h.temperature_2m?.[i])).filter(Number.isFinite),winds=idx.map(i=>num(h.wind_speed_10m?.[i])).filter(Number.isFinite);
    if(probs.length&&d.precipitation_probability_max)d.precipitation_probability_max[di]=Math.round(Math.max(...probs));
    if(prec.length&&d.precipitation_sum)d.precipitation_sum[di]=Math.round(prec.reduce((s,v)=>s+v,0)*10)/10;
    if(temps.length&&d.temperature_2m_max&&d.temperature_2m_min){d.temperature_2m_max[di]=Math.round(Math.max(...temps)*10)/10;d.temperature_2m_min[di]=Math.round(Math.min(...temps)*10)/10;}
    if(winds.length&&d.wind_speed_10m_max)d.wind_speed_10m_max[di]=Math.round(Math.max(...winds)*10)/10;
  });
}
function deriveRainWindow(forecast,nowIndex,limit=24){
  const h=forecast.hourly||{},times=h.time||[],end=Math.min(nowIndex+limit,times.length); const groups=[]; let g=null,lastWet=-9;
  for(let i=nowIndex;i<end;i++){
    const p=num(h.precipitation_probability?.[i])||0,mm=Math.max(0,num(h.precipitation?.[i])||0),wet=p>=45||(p>=30&&mm>=0.1);
    if(wet){
      if(!g||i-lastWet>2){g={startIndex:i,endIndex:i,peakIndex:i,peakProb:p,totalMm:mm};groups.push(g);}else{g.endIndex=i;g.totalMm+=mm;if(p>g.peakProb){g.peakProb=p;g.peakIndex=i;}}
      lastWet=i;
    }
  }
  if(!groups.length){
    const vals=[];for(let i=nowIndex;i<end;i++)vals.push({i,p:num(h.precipitation_probability?.[i])||0,mm:Math.max(0,num(h.precipitation?.[i])||0)});
    const peak=vals.reduce((a,b)=>!a||b.p>a.p?b:a,null);return {noRain:true,peakProb:peak?.p||0,peakTime:times[peak?.i]||null,totalMm:Math.round(vals.reduce((s,x)=>s+x.mm,0)*10)/10};
  }
  groups.sort((a,b)=>(b.peakProb+b.totalMm*5)-(a.peakProb+a.totalMm*5)); const best=groups[0];
  return {noRain:false,start:times[best.startIndex],end:times[best.endIndex],peakTime:times[best.peakIndex],peakProb:Math.round(best.peakProb),totalMm:Math.round(best.totalMm*10)/10,startIndex:best.startIndex,endIndex:best.endIndex};
}
function sourcePeakOffset(data,nowTime,key='precipitation',probMode=false){
  const times=data?.hourly?.time||[],start=Math.max(0,times.findIndex(t=>t>=nowTime)); if(start<0)return null; let best=null;
  for(let i=start;i<Math.min(start+24,times.length);i++){
    const v=probMode?ensembleRainProbability(data,times[i],0.1):num(data.hourly?.[key]?.[i]); if(!Number.isFinite(v))continue;
    if(!best||v>best.v)best={i,v};
  }
  return best?best.i-start:null;
}
function timingStability(base,ensembles,runHistory){
  const now=base.current?.time,peaks=[];
  const bt=base.hourly?.time||[],bi=Math.max(0,bt.findIndex(t=>t>=now)); let bp=null;
  for(let i=bi;i<Math.min(bi+24,bt.length);i++){const v=num(base.hourly?.precipitation_probability?.[i]);if(Number.isFinite(v)&&(!bp||v>bp.v))bp={i,v};}
  if(bp)peaks.push(bp.i-bi);
  ensembles.forEach(e=>{const x=sourcePeakOffset(e.data,now,'precipitation',true);if(Number.isFinite(x))peaks.push(x);});
  runHistory.forEach(r=>{const x=sourcePeakOffset(r.data,now,'precipitation',false);if(Number.isFinite(x))peaks.push(x);});
  if(peaks.length<2)return {score:55,label:'media',spreadHours:null,samples:peaks.length};
  const s=std(peaks)||0,score=Math.round(clamp(100-s*16,20,100));
  return {score,label:score>=75?'alta':score>=50?'media':'baja',spreadHours:Math.round(s*10)/10,samples:peaks.length};
}

function applySmartFusion(base,deterministic,ensembles,runHistory,radar,customWeights={}){
  const out=clone(base),times=out.hourly?.time||[],nowIndex=Math.max(0,times.findIndex(t=>t>=out.current?.time)),confScores=[],training=[];
  const providerWeights={ecmwf:customWeights.ecmwf??0.38,icon:customWeights.icon??0.24,gfs:customWeights.gfs??0.16,meteofrance:customWeights.meteofrance??0.22};
  const rainWeights={ecmwf:customWeights.rainEcmwf??0.50,icon:customWeights.rainIcon??0.30,gfs:customWeights.rainGfs??0.20};
  const timing=timingStability(base,ensembles,runHistory);

  for(let i=0;i<times.length;i++){
    const t=times[i],hoursAhead=Math.max(0,i-nowIndex),baseTemp=num(base.hourly?.temperature_2m?.[i]),baseFeels=num(base.hourly?.apparent_temperature?.[i]),basePrec=num(base.hourly?.precipitation?.[i]),baseProb=num(base.hourly?.precipitation_probability?.[i]),baseWind=num(base.hourly?.wind_speed_10m?.[i]);
    const detItems=deterministic.map(m=>({m,weight:providerWeights[m.kind]||0.1}));
    const detTemp=weighted(detItems.map(x=>({value:hourlyValue(x.m.data,t,'temperature_2m'),weight:x.weight}))),detFeels=weighted(detItems.map(x=>({value:hourlyValue(x.m.data,t,'apparent_temperature'),weight:x.weight}))),detPrec=weighted(detItems.map(x=>({value:hourlyValue(x.m.data,t,'precipitation'),weight:x.weight}))),detWind=weighted(detItems.map(x=>({value:hourlyValue(x.m.data,t,'wind_speed_10m'),weight:x.weight})));
    const detShare=hoursAhead<=3?.62:hoursAhead<=12?.52:hoursAhead<=48?.38:.30;
    if(Number.isFinite(baseTemp)&&Number.isFinite(detTemp))out.hourly.temperature_2m[i]=Math.round((baseTemp*(1-detShare*.7)+detTemp*(detShare*.7))*10)/10;
    if(Number.isFinite(baseFeels)&&Number.isFinite(detFeels))out.hourly.apparent_temperature[i]=Math.round((baseFeels*(1-detShare*.65)+detFeels*(detShare*.65))*10)/10;
    if(Number.isFinite(basePrec)&&Number.isFinite(detPrec))out.hourly.precipitation[i]=Math.max(0,Math.round((basePrec*(1-detShare)+detPrec*detShare)*100)/100);
    if(Number.isFinite(baseWind)&&Number.isFinite(detWind))out.hourly.wind_speed_10m[i]=Math.max(0,Math.round((baseWind*(1-detShare*.7)+detWind*(detShare*.7))*10)/10);

    const ensProbItems=ensembles.map(e=>({kind:e.kind,value:ensembleRainProbability(e.data,t,.1),weight:rainWeights[e.kind]||0.2})).filter(x=>Number.isFinite(x.value)),ensProbs=ensProbItems.map(x=>x.value),ensProb=weighted(ensProbItems);
    const ensShare=hoursAhead<=3?.48:hoursAhead<=12?.58:hoursAhead<=48?.70:.76;
    let p=Number.isFinite(baseProb)?baseProb:ensProb;
    if(Number.isFinite(p)&&Number.isFinite(ensProb))p=p*(1-ensShare)+ensProb*ensShare;

    const runVals=[];
    const liveEcmwf=deterministic.find(x=>x.kind==='ecmwf'); const liveMm=liveEcmwf?hourlyValue(liveEcmwf.data,t,'precipitation'):null; if(Number.isFinite(liveMm))runVals.push(liveMm);
    runHistory.forEach(r=>{const v=hourlyValue(r.data,t,'precipitation');if(Number.isFinite(v))runVals.push(v);});
    let runWetProb=null,runAgreement=null;
    if(runVals.length>=2){
      runWetProb=100*runVals.filter(v=>v>=0.1).length/runVals.length;
      const wet=runVals.map(v=>v>=0.1?1:0),wetStd=std(wet)||0; runAgreement=clamp(100-wetStd*130,35,100);
      if(Number.isFinite(p)&&hoursAhead>=4&&hoursAhead<=72){const rw=hoursAhead<=24?.20:.14;p=p*(1-rw)+runWetProb*rw;}
    }

    if(Number.isFinite(p)){
      if(hoursAhead<=3&&radar?.available){
        if(radar.raining)p=Math.max(p,hoursAhead===0?98:hoursAhead===1?90:hoursAhead===2?82:72);
        else if(radar.trend==='approaching'&&Number.isFinite(radar.nearbyKm)){
          const nearBoost=clamp((30-radar.nearbyKm)*0.8,0,20),timeFactor=hoursAhead===0?.45:hoursAhead===1?1:hoursAhead===2?.75:.45;p+=nearBoost*timeFactor;
        } else if(hoursAhead===0&&Number.isFinite(radar.nearbyKm)&&radar.nearbyKm>35){p=Math.min(p,Math.max(20,p*.72));}
      }
      const stormProb=num(base.hourly?.thunderstorm_probability?.[i]); if(Number.isFinite(stormProb)&&stormProb>=30)p=Math.max(p,stormProb*.8);
      out.hourly.precipitation_probability[i]=Math.round(clamp(p,0,100));
    }

    if(hoursAhead<48){
      const rainTrain={};ensProbItems.forEach(x=>{rainTrain[x.kind]=Math.round(x.value);});training.push({time:t,leadHours:hoursAhead,rainProb:rainTrain});
    }
    if(hoursAhead<24){
      const agreement=ensProbs.length>=2?clamp(100-(std(ensProbs)||0)*1.5,0,100):55,certainty=Number.isFinite(ensProb)?Math.abs(ensProb-50)*2:50,spreadTemps=ensembles.map(e=>ensembleSpread(e.data,t,'temperature_2m')).filter(Number.isFinite),tempPenalty=spreadTemps.length?clamp((mean(spreadTemps)||0)*8,0,25):10;
      let score=agreement*.46+certainty*.27+timing.score*.17+(Number.isFinite(runAgreement)?runAgreement*.10:5)-tempPenalty;
      if(hoursAhead<=2&&radar?.available)score=score*.82+(radar.raining||radar.trend==='approaching'?18:10);
      confScores.push(clamp(score,0,100));
    }
  }

  recomputeDaily(out);
  const baseScore=Math.round(mean(confScores)||55),score=Math.round(clamp(baseScore*.82+timing.score*.18,0,100)),level=score>=75?'high':score>=50?'medium':'low';
  const rainWindow=deriveRainWindow(out,nowIndex,24);
  return {forecast:out,confidence:{score,level,label:level==='high'?'alta':level==='medium'?'media':'baja',timingScore:timing.score,timingLabel:timing.label,timingSpreadHours:timing.spreadHours},training,rainWindow,timing};
}

module.exports = async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=600');
  const lat=num(req.query.lat),lon=num(req.query.lon); if(lat===null||lon===null||Math.abs(lat)>90||Math.abs(lon)>180)return res.status(400).json({error:'Coordenadas no válidas'});
  try{
    const runs=likelyAvailableEcmwfRuns();
    const jobs=[
      fetchJson(baseForecastUrl(lat,lon),8000),
      fetchJson(providerUrl('ecmwf',lat,lon),8000),
      fetchJson(providerUrl('dwd-icon',lat,lon),8000),
      fetchJson(providerUrl('gfs',lat,lon),8000),
      fetchJson(providerUrl('meteofrance',lat,lon),8000),
      fetchJson(ensembleUrl('ecmwf_ifs025',lat,lon),9000),
      fetchJson(ensembleUrl('icon_seamless',lat,lon),9000),
      fetchJson(ensembleUrl('gfs_seamless',lat,lon),9000),
      fetchJson(singleRunUrl(runs[0],lat,lon),7000),
      fetchJson(singleRunUrl(runs[1],lat,lon),7000),
      getRadarNowcast(lat,lon)
    ];
    const settled=await Promise.allSettled(jobs); if(settled[0].status!=='fulfilled')throw settled[0].reason;
    const base=settled[0].value,deterministic=[];
    [['ecmwf',1],['icon',2],['gfs',3],['meteofrance',4]].forEach(([kind,idx])=>{if(settled[idx].status==='fulfilled')deterministic.push({kind,data:settled[idx].value});});
    const ensembles=[];[['ecmwf',5],['icon',6],['gfs',7]].forEach(([kind,idx])=>{if(settled[idx].status==='fulfilled')ensembles.push({kind,data:settled[idx].value});});
    const runHistory=[];[[runs[0],8],[runs[1],9]].forEach(([run,idx])=>{if(settled[idx].status==='fulfilled')runHistory.push({run,data:settled[idx].value});});
    const radar=settled[10].status==='fulfilled'?settled[10].value:{available:false};
    const qWeight=(name,def)=>{const v=num(req.query[name]);return v===null?def:clamp(v,0.03,0.85);};
    const customWeights={ecmwf:qWeight('we',0.38),icon:qWeight('wi',0.24),gfs:qWeight('wg',0.16),meteofrance:qWeight('wm',0.22),rainEcmwf:qWeight('re',0.50),rainIcon:qWeight('ri',0.30),rainGfs:qWeight('rg',0.20)};
    const fused=applySmartFusion(base,deterministic,ensembles,runHistory,radar,customWeights);
    res.status(200).json({
      generatedAt:new Date().toISOString(),forecast:fused.forecast,confidence:fused.confidence,
      smart:{
        deterministicSources:deterministic.map(x=>x.kind),ensembleSources:ensembles.map(x=>x.kind),
        runHistory:{requested:runs,available:runHistory.map(x=>x.run),count:runHistory.length},
        radar,rainWindow:fused.rainWindow,timing:fused.timing,training:fused.training,weights:customWeights,
        engine:'horizon-weighted-multimodel-ensemble-radar-run-stability-v3'
      }
    });
  }catch(err){
    console.error('smart forecast',err);
    res.status(502).json({error:'No se pudo generar la previsión inteligente',detail:err?.message||String(err)});
  }
};
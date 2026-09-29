(function(){
  const nativeFetch = window.fetch.bind(window);
  const SMART_PREFIX = 'https://api.open-meteo.com/v1/forecast?';
  const STORE = 'tiempoCalibrationV1';

  function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
  function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
  function mean(a){const v=a.filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:0;}
  function key(lat,lon){return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;}
  function loadStore(){try{return JSON.parse(localStorage.getItem(STORE)||'{}');}catch{return {};}}
  function saveStore(s){try{localStorage.setItem(STORE,JSON.stringify(s));}catch{}}
  function currentHour(iso){return String(iso||'').slice(0,13);}
  function recomputeDaily(f){
    const h=f.hourly||{},d=f.daily||{}; if(!Array.isArray(h.time)||!Array.isArray(d.time))return;
    d.time.forEach((date,di)=>{const idx=[];h.time.forEach((t,i)=>{if(String(t).startsWith(date))idx.push(i);});if(!idx.length)return;
      const probs=idx.map(i=>n(h.precipitation_probability?.[i])).filter(Number.isFinite);
      const temps=idx.map(i=>n(h.temperature_2m?.[i])).filter(Number.isFinite);
      if(probs.length&&d.precipitation_probability_max)d.precipitation_probability_max[di]=Math.round(Math.max(...probs));
      if(temps.length&&d.temperature_2m_max&&d.temperature_2m_min){d.temperature_2m_max[di]=Math.round(Math.max(...temps)*10)/10;d.temperature_2m_min[di]=Math.round(Math.min(...temps)*10)/10;}
    });
  }
  function verify(store,loc,forecast,smart){
    const bucket=store[loc]||(store[loc]={snapshots:[],rain:[],temp:[],modelSnapshots:[],modelTemp:{},modelRain:{}}); bucket.modelSnapshots=bucket.modelSnapshots||[];bucket.modelTemp=bucket.modelTemp||{};bucket.modelRain=bucket.modelRain||{}; const cur=currentHour(forecast.current?.time); if(!cur)return bucket;
    const remain=[];
    for(const s of bucket.snapshots||[]){
      if(currentHour(s.time)!==cur){remain.push(s);continue;}
      const actualTemp=n(forecast.current?.temperature_2m);
      if(Number.isFinite(actualTemp)&&Number.isFinite(s.temp)){bucket.temp.push({e:actualTemp-s.temp,t:Date.now()});}
      if(smart?.radar?.available&&typeof smart.radar.raining==='boolean'&&Number.isFinite(s.prob)){bucket.rain.push({p:s.prob,y:smart.radar.raining?1:0,t:Date.now()});}
    }
    const modelRemain=[];
    for(const ms of bucket.modelSnapshots||[]){
      if(currentHour(ms.time)!==cur){modelRemain.push(ms);continue;}
      const actualTemp=n(forecast.current?.temperature_2m);
      if(Number.isFinite(actualTemp))for(const [kind,pred] of Object.entries(ms.temp||{})){const v=n(pred);if(Number.isFinite(v)){(bucket.modelTemp[kind]||(bucket.modelTemp[kind]=[])).push(Math.abs(actualTemp-v));}}
      if(smart?.radar?.available&&typeof smart.radar.raining==='boolean')for(const [kind,pred] of Object.entries(ms.rainProb||{})){const p=n(pred);if(Number.isFinite(p)){const y=smart.radar.raining?1:0;(bucket.modelRain[kind]||(bucket.modelRain[kind]=[])).push(((p/100)-y)**2);}}
    }
    bucket.modelSnapshots=modelRemain;
    bucket.snapshots=remain; bucket.temp=(bucket.temp||[]).slice(-80); bucket.rain=(bucket.rain||[]).slice(-240);
    Object.keys(bucket.modelTemp).forEach(k=>bucket.modelTemp[k]=(bucket.modelTemp[k]||[]).slice(-100)); Object.keys(bucket.modelRain).forEach(k=>bucket.modelRain[k]=(bucket.modelRain[k]||[]).slice(-180));
    return bucket;
  }
  function normalizeWeights(raw,defaults){
    const keys=Object.keys(defaults),vals={}; let sum=0; keys.forEach(k=>{const v=Number.isFinite(raw[k])?raw[k]:defaults[k];vals[k]=Math.max(.02,v);sum+=vals[k];}); keys.forEach(k=>vals[k]=vals[k]/sum); return vals;
  }
  function buildWeights(bucket){
    const dflt={ecmwf:.42,icon:.28,gfs:.18,highres:.12},rdflt={ecmwf:.50,icon:.30,gfs:.20}; const tempRaw={},rainRaw={};
    for(const [k,b] of Object.entries(dflt)){const a=(bucket.modelTemp?.[k]||[]).map(n).filter(Number.isFinite);tempRaw[k]=a.length>=8?b/(.5+mean(a)):b;}
    for(const [k,b] of Object.entries(rdflt)){const a=(bucket.modelRain?.[k]||[]).map(n).filter(Number.isFinite);rainRaw[k]=a.length>=8?b/(.08+mean(a)):b;}
    return {det:normalizeWeights(tempRaw,dflt),rain:normalizeWeights(rainRaw,rdflt)};
  }
  function calibrate(bucket,forecast){
    const tempRecs=bucket.temp||[]; const bias=tempRecs.length>=8?clamp(mean(tempRecs.map(r=>n(r.e))),-2.5,2.5):0;
    const rainRecs=bucket.rain||[];
    const mapProb=p=>{
      if(rainRecs.length<20)return p;
      const lo=Math.floor(clamp(p,0,99)/20)*20,hi=lo+20; const bin=rainRecs.filter(r=>r.p>=lo&&r.p<hi); if(bin.length<6)return p;
      const observed=100*mean(bin.map(r=>r.y)); const w=Math.min(.55,bin.length/30); return Math.round(clamp(p*(1-w)+observed*w,0,100));
    };
    const now=forecast.current?.time;
    (forecast.hourly?.time||[]).forEach((t,i)=>{if(now&&t<now)return;
      const tv=n(forecast.hourly?.temperature_2m?.[i]); if(Number.isFinite(tv)&&bias)forecast.hourly.temperature_2m[i]=Math.round((tv+bias)*10)/10;
      const av=n(forecast.hourly?.apparent_temperature?.[i]); if(Number.isFinite(av)&&bias)forecast.hourly.apparent_temperature[i]=Math.round((av+bias)*10)/10;
      const p=n(forecast.hourly?.precipitation_probability?.[i]); if(Number.isFinite(p))forecast.hourly.precipitation_probability[i]=mapProb(p);
    });
    recomputeDaily(forecast);
    return {tempBias:bias,tempSamples:tempRecs.length,rainSamples:rainRecs.length};
  }
  function snapshot(bucket,forecast,training){
    const now=forecast.current?.time; const existing=new Map((bucket.snapshots||[]).map(s=>[s.time,s]));
    (forecast.hourly?.time||[]).forEach((t,i)=>{if(now&&t<now)return; existing.set(t,{time:t,temp:n(forecast.hourly?.temperature_2m?.[i]),prob:n(forecast.hourly?.precipitation_probability?.[i]),issued:Date.now()});});
    bucket.snapshots=[...existing.values()].sort((a,b)=>String(a.time).localeCompare(String(b.time))).slice(-72);
    const modelExisting=new Map((bucket.modelSnapshots||[]).map(s=>[s.time,s])); (training||[]).forEach(t=>modelExisting.set(t.time,t)); bucket.modelSnapshots=[...modelExisting.values()].sort((a,b)=>String(a.time).localeCompare(String(b.time))).slice(-72);
  }
  function syncConfidence(){
    const c=window.__smartConfidence,el=document.getElementById('rainConfidence'); if(!c||!el)return;
    const wanted=`Confianza ${c.label}`,klass=`confidence ${c.level}`; if(el.textContent!==wanted)el.textContent=wanted;if(el.className!==klass)el.className=klass;
  }
  function applyConfidence(meta){
    const c=meta?.confidence; if(!c)return; window.__smartConfidence=c; syncConfidence();
    const el=document.getElementById('rainConfidence'); if(!el||window.__smartConfidenceObserver)return;
    window.__smartConfidenceObserver=new MutationObserver(()=>syncConfidence());
    window.__smartConfidenceObserver.observe(el,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['class']});
  }
  function applyAttribution(meta){
    const el=document.querySelector('.source-note'); if(!el)return;
    let txt='Datos meteorológicos: Open-Meteo. Avisos: AEMET.';
    if(meta?.smart?.radar?.available)txt+=' Radar: RainViewer.';
    txt+=' La previsión puede cambiar con nuevas actualizaciones de los modelos meteorológicos.';
    el.textContent=txt;
    if(meta?.smart?.radar?.available)el.title='El radar de corto plazo usa RainViewer. La predicción multimodelo usa ECMWF, ICON y GFS cuando están disponibles.';
  }

  window.fetch = async function(input,init){
    const url=typeof input==='string'?input:input?.url||'';
    if(url.startsWith(SMART_PREFIX)&&url.includes('forecast_days=7')){
      try{
        const u=new URL(url),lat=u.searchParams.get('latitude'),lon=u.searchParams.get('longitude');
        if(lat&&lon){
          const store=loadStore(),loc=key(lat,lon),preBucket=store[loc]||{snapshots:[],rain:[],temp:[],modelSnapshots:[],modelTemp:{},modelRain:{}}; const learned=buildWeights(preBucket);
          const sp=new URLSearchParams({lat,lon,we:learned.det.ecmwf,wi:learned.det.icon,wg:learned.det.gfs,wh:learned.det.highres,re:learned.rain.ecmwf,ri:learned.rain.icon,rg:learned.rain.gfs});
          const r=await nativeFetch(`/api/smart?${sp}`,{cache:'no-store'});
          if(r.ok){
            const payload=await r.json(); const f=payload.forecast;
            if(f){
              const bucket=verify(store,loc,f,payload.smart); const calibration=calibrate(bucket,f); snapshot(bucket,f,payload.smart?.training);store[loc]=bucket;saveStore(store);
              window.__smartMeta={confidence:payload.confidence,smart:payload.smart,calibration};
              queueMicrotask(()=>{applyConfidence(window.__smartMeta);applyAttribution(window.__smartMeta);});
              return new Response(JSON.stringify(f),{status:200,headers:{'Content-Type':'application/json','X-Tiempo-Smart':'1'}});
            }
          }
        }
      }catch(e){console.warn('Smart forecast fallback',e);}
    }
    return nativeFetch(input,init);
  };
})();

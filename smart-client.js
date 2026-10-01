(function(){
  const nativeFetch = window.fetch.bind(window);
  const SMART_PREFIX = 'https://api.open-meteo.com/v1/forecast?';
  const STORE = 'huracanSmartV3';

  function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
  function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
  function mean(a){const v=a.filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:0;}
  function key(lat,lon){return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;}
  function loadStore(){try{return JSON.parse(localStorage.getItem(STORE)||'{}');}catch{return {};}}
  function saveStore(s){try{localStorage.setItem(STORE,JSON.stringify(s));}catch{}}
  function currentHour(iso){return String(iso||'').slice(0,13);}
  function hourDiff(a,b){const da=new Date(a),db=new Date(b);return Number.isFinite(da.getTime())&&Number.isFinite(db.getTime())?Math.round((db-da)/3600000):null;}
  function bucketFor(store,loc){
    const b=store[loc]||(store[loc]={snapshots:[],rain:[],modelSnapshots:[],modelRain:{},stable:{probs:{},amounts:{},flips:{},window:null,windowCandidate:null},history:[]});
    b.snapshots=b.snapshots||[];b.rain=b.rain||[];b.modelSnapshots=b.modelSnapshots||[];b.modelRain=b.modelRain||{};b.history=b.history||[];
    b.stable=b.stable||{probs:{},amounts:{},flips:{},window:null,windowCandidate:null};
    b.stable.probs=b.stable.probs||{};b.stable.amounts=b.stable.amounts||{};b.stable.flips=b.stable.flips||{};
    return b;
  }
  function recomputeDaily(f){
    const h=f.hourly||{},d=f.daily||{}; if(!Array.isArray(h.time)||!Array.isArray(d.time))return;
    d.time.forEach((date,di)=>{
      const idx=[];h.time.forEach((t,i)=>{if(String(t).startsWith(date))idx.push(i);});if(!idx.length)return;
      const probs=idx.map(i=>n(h.precipitation_probability?.[i])).filter(Number.isFinite),prec=idx.map(i=>n(h.precipitation?.[i])).filter(Number.isFinite),temps=idx.map(i=>n(h.temperature_2m?.[i])).filter(Number.isFinite);
      if(probs.length&&d.precipitation_probability_max)d.precipitation_probability_max[di]=Math.round(Math.max(...probs));
      if(prec.length&&d.precipitation_sum)d.precipitation_sum[di]=Math.round(prec.reduce((s,v)=>s+Math.max(0,v),0)*10)/10;
      if(temps.length&&d.temperature_2m_max&&d.temperature_2m_min){d.temperature_2m_max[di]=Math.round(Math.max(...temps)*10)/10;d.temperature_2m_min[di]=Math.round(Math.min(...temps)*10)/10;}
    });
  }

  function verify(store,loc,forecast,smart){
    const bucket=bucketFor(store,loc),cur=currentHour(forecast.current?.time);if(!cur)return bucket;
    const radarTruth=smart?.radar?.available&&typeof smart.radar.raining==='boolean'?smart.radar.raining:null;
    const keep=[];
    for(const s of bucket.snapshots){
      if(currentHour(s.time)!==cur){keep.push(s);continue;}
      if(radarTruth!==null&&Number.isFinite(s.prob))bucket.rain.push({p:s.prob,y:radarTruth?1:0,lead:s.leadHours??null,t:Date.now()});
    }
    bucket.snapshots=keep;
    const modelKeep=[];
    for(const ms of bucket.modelSnapshots){
      if(currentHour(ms.time)!==cur){modelKeep.push(ms);continue;}
      if(radarTruth!==null){
        for(const [kind,pred] of Object.entries(ms.rainProb||{})){
          const p=n(pred);if(Number.isFinite(p)){
            const list=bucket.modelRain[kind]||(bucket.modelRain[kind]=[]);
            list.push({brier:((p/100)-(radarTruth?1:0))**2,lead:ms.leadHours??null,t:Date.now()});
          }
        }
      }
    }
    bucket.modelSnapshots=modelKeep;
    bucket.rain=bucket.rain.slice(-300);
    Object.keys(bucket.modelRain).forEach(k=>bucket.modelRain[k]=(bucket.modelRain[k]||[]).slice(-240));
    return bucket;
  }
  function normalizeWeights(raw,defaults){
    const keys=Object.keys(defaults),vals={};let sum=0;
    keys.forEach(k=>{const v=Number.isFinite(raw[k])?raw[k]:defaults[k];vals[k]=Math.max(.03,v);sum+=vals[k];});
    keys.forEach(k=>vals[k]/=sum);return vals;
  }
  function buildWeights(bucket){
    const det={ecmwf:.38,icon:.24,gfs:.16,meteofrance:.22},rainDefaults={ecmwf:.50,icon:.30,gfs:.20},rainRaw={};
    for(const [k,b] of Object.entries(rainDefaults)){
      const recs=(bucket.modelRain?.[k]||[]).map(x=>n(x?.brier??x)).filter(Number.isFinite);
      rainRaw[k]=recs.length>=10?b/(.06+mean(recs)):b;
    }
    return {det,rain:normalizeWeights(rainRaw,rainDefaults)};
  }
  function calibrateRain(bucket,forecast){
    const recs=bucket.rain||[];
    const mapProb=p=>{
      if(recs.length<24)return p;
      const lo=Math.floor(clamp(p,0,99)/20)*20,hi=lo+20,bin=recs.filter(r=>r.p>=lo&&r.p<hi);
      if(bin.length<8)return p;
      const observed=100*mean(bin.map(r=>r.y)),w=Math.min(.42,bin.length/40);
      return Math.round(clamp(p*(1-w)+observed*w,0,100));
    };
    const now=forecast.current?.time;
    (forecast.hourly?.time||[]).forEach((t,i)=>{if(now&&t<now)return;const p=n(forecast.hourly?.precipitation_probability?.[i]);if(Number.isFinite(p))forecast.hourly.precipitation_probability[i]=mapProb(p);});
    recomputeDaily(forecast);
    return {rainSamples:recs.length};
  }
  function snapshot(bucket,forecast,training){
    const now=forecast.current?.time,nowIdx=Math.max(0,(forecast.hourly?.time||[]).findIndex(t=>t>=now));
    const existing=new Map(bucket.snapshots.map(s=>[s.time,s]));
    (forecast.hourly?.time||[]).forEach((t,i)=>{if(now&&t<now)return;existing.set(t,{time:t,prob:n(forecast.hourly?.precipitation_probability?.[i]),leadHours:Math.max(0,i-nowIdx),issued:Date.now()});});
    bucket.snapshots=[...existing.values()].sort((a,b)=>String(a.time).localeCompare(String(b.time))).slice(-120);
    const modelExisting=new Map(bucket.modelSnapshots.map(s=>[s.time,s]));
    (training||[]).forEach(t=>modelExisting.set(t.time,t));
    bucket.modelSnapshots=[...modelExisting.values()].sort((a,b)=>String(a.time).localeCompare(String(b.time))).slice(-120);
  }

  function deriveWindow(f,limit=24){
    const h=f.hourly||{},times=h.time||[],now=f.current?.time,nowIdx=Math.max(0,times.findIndex(t=>t>=now)),end=Math.min(nowIdx+limit,times.length),groups=[];let g=null,lastWet=-9;
    for(let i=nowIdx;i<end;i++){
      const p=n(h.precipitation_probability?.[i])||0,mm=Math.max(0,n(h.precipitation?.[i])||0),wet=p>=45||(p>=30&&mm>=0.1);
      if(wet){
        if(!g||i-lastWet>2){g={start:i,end:i,peak:i,peakProb:p,totalMm:mm};groups.push(g);}else{g.end=i;g.totalMm+=mm;if(p>g.peakProb){g.peak=i;g.peakProb=p;}}
        lastWet=i;
      }
    }
    if(!groups.length){
      let peak={i:nowIdx,p:0},total=0;for(let i=nowIdx;i<end;i++){const p=n(h.precipitation_probability?.[i])||0,mm=Math.max(0,n(h.precipitation?.[i])||0);total+=mm;if(p>peak.p)peak={i,p};}
      return {noRain:true,peakProb:Math.round(peak.p),peakTime:times[peak.i]||null,totalMm:Math.round(total*10)/10};
    }
    groups.sort((a,b)=>(b.peakProb+b.totalMm*5)-(a.peakProb+a.totalMm*5));const x=groups[0];
    return {noRain:false,start:times[x.start],end:times[x.end],peakTime:times[x.peak],peakProb:Math.round(x.peakProb),totalMm:Math.round(x.totalMm*10)/10};
  }
  function windowKey(w){return !w||w.noRain?'dry':`${currentHour(w.start)}|${currentHour(w.end)}`;}
  function windowShiftHours(a,b){
    if(!a||!b||a.noRain!==b.noRain)return 99;if(a.noRain&&b.noRain)return 0;
    return Math.max(Math.abs(hourDiff(a.start,b.start)||0),Math.abs(hourDiff(a.end,b.end)||0));
  }
  function stabilizeWindow(bucket,newWindow,confidence,radar){
    const stable=bucket.stable,old=stable.window;
    if(!old){stable.window=newWindow;stable.windowCandidate=null;return newWindow;}
    const shift=windowShiftHours(old,newWindow),force=(confidence?.score||0)>=82||radar?.raining||((radar?.trend==='approaching')&&Number.isFinite(radar?.nearbyKm)&&radar.nearbyKm<15);
    if(shift<=1){stable.window={...newWindow};stable.windowCandidate=null;return stable.window;}
    if(force){stable.window={...newWindow};stable.windowCandidate=null;return stable.window;}
    const k=windowKey(newWindow),cand=stable.windowCandidate;
    if(cand?.key===k)cand.count=(cand.count||1)+1;else stable.windowCandidate={key:k,count:1,window:newWindow};
    if((stable.windowCandidate?.count||0)>=2){stable.window={...newWindow};stable.windowCandidate=null;return stable.window;}
    return old;
  }
  function localStabilityScore(bucket,rawForecast){
    const times=rawForecast.hourly?.time||[],now=rawForecast.current?.time,idx=Math.max(0,times.findIndex(t=>t>=now)),diffs=[];
    for(let i=idx;i<Math.min(idx+24,times.length);i++){
      const old=n(bucket.stable.probs?.[times[i]]),fresh=n(rawForecast.hourly?.precipitation_probability?.[i]);if(Number.isFinite(old)&&Number.isFinite(fresh))diffs.push(Math.abs(fresh-old));
    }
    if(diffs.length<4)return 60;return Math.round(clamp(100-mean(diffs)*2.2,20,100));
  }
  function stabilizeForecast(bucket,forecast,smart,serverConfidence){
    const h=forecast.hourly||{},times=h.time||[],now=forecast.current?.time,nowIdx=Math.max(0,times.findIndex(t=>t>=now)),stable=bucket.stable,radar=smart?.radar||{};
    const localScore=localStabilityScore(bucket,forecast),serverScore=n(serverConfidence?.score)??55;
    const combinedScore=Math.round(clamp(serverScore*.78+localScore*.22,0,100)),combinedLevel=combinedScore>=75?'high':combinedScore>=50?'medium':'low';
    const combinedConfidence={...serverConfidence,score:combinedScore,level:combinedLevel,label:combinedLevel==='high'?'alta':combinedLevel==='medium'?'media':'baja',localStabilityScore:localScore};
    const newProbs={},newAmounts={},newFlips={};

    for(let i=0;i<times.length;i++){
      const t=times[i];if(now&&t<now)continue;
      const raw=n(h.precipitation_probability?.[i]),rawMm=Math.max(0,n(h.precipitation?.[i])||0);if(!Number.isFinite(raw))continue;
      const hours=Math.max(0,i-nowIdx),prev=n(stable.probs[t]),prevMm=n(stable.amounts[t]);
      let alpha=hours<=3?.80:hours<=12?.56:hours<=24?.43:hours<=48?.34:.27;
      if(serverScore>=80)alpha+=.08;if(serverScore<50)alpha-=.08;
      if(Math.abs(raw-(prev??raw))>=30&&hours>3&&serverScore<75)alpha*=.72;
      if(hours<=2&&radar?.raining)alpha=1;
      alpha=clamp(alpha,.18,1);
      let p=Number.isFinite(prev)?prev*(1-alpha)+raw*alpha:raw;

      if(Number.isFinite(prev)&&hours>3&&serverScore<82){
        const prevWet=prev>=45,rawWet=raw>=45;
        if(prevWet!==rawWet){
          const prior=stable.flips?.[t],cand=prior&&prior.state===rawWet?{state:rawWet,count:(prior.count||1)+1}:{state:rawWet,count:1};
          if(cand.count<2){newFlips[t]=cand;p=prevWet?Math.max(p,45):Math.min(p,44);}
        }
      }
      p=Math.round(clamp(p,0,100));h.precipitation_probability[i]=p;newProbs[t]=p;
      const mmAlpha=hours<=6?.70:hours<=24?.48:.35,mm=Number.isFinite(prevMm)?prevMm*(1-mmAlpha)+rawMm*mmAlpha:rawMm;
      h.precipitation[i]=Math.max(0,Math.round(mm*100)/100);newAmounts[t]=h.precipitation[i];
    }
    stable.probs=newProbs;stable.amounts=newAmounts;stable.flips=newFlips;
    recomputeDaily(forecast);
    const derived=deriveWindow(forecast,24),window=stabilizeWindow(bucket,derived,combinedConfidence,radar);
    forecast.smart_rain_window=window;
    forecast.smart_confidence=combinedConfidence;
    forecast.smart_stability={score:localScore,label:localScore>=75?'alta':localScore>=50?'media':'baja'};
    forecast.smart_sources={deterministic:smart?.deterministicSources||[],ensemble:smart?.ensembleSources||[],runHistory:smart?.runHistory||null,radar:radar?.available?radar:null};
    stable.updated=Date.now();
    bucket.history.push({at:Date.now(),window:derived,serverScore,localScore});bucket.history=bucket.history.slice(-20);
    return {forecast,confidence:combinedConfidence,window};
  }

  function syncConfidence(){
    const c=window.__smartConfidence,el=document.getElementById('rainConfidence');if(!c||!el)return;
    const wanted=`Confianza ${c.label}`,klass=`confidence ${c.level}`;if(el.textContent!==wanted)el.textContent=wanted;if(el.className!==klass)el.className=klass;
  }
  function applyConfidence(meta){
    const c=meta?.confidence;if(!c)return;window.__smartConfidence=c;syncConfidence();
    const el=document.getElementById('rainConfidence');if(!el||window.__smartConfidenceObserver)return;
    window.__smartConfidenceObserver=new MutationObserver(()=>syncConfidence());
    window.__smartConfidenceObserver.observe(el,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['class']});
  }
  function hh(iso){return String(iso||'').slice(11,16)||'—';}
  function rainWindowText(meta){
    const w=meta?.window,c=meta?.confidence||{};if(!w)return null;
    const timing=(c.timingLabel==='alta'&&c.localStabilityScore>=65)?'horario estable':c.timingLabel==='baja'?'horario todavía variable':'horario bastante estable';
    if(w.noRain){
      return {headline:'Sin lluvia prevista en las próximas 24 h',detail:`Probabilidad máxima: ${Math.round(w.peakProb||0)} %${w.peakTime?` hacia las ${hh(w.peakTime)}`:''} · ${timing}.`};
    }
    const start=hh(w.start),end=hh(w.end),peak=hh(w.peakTime),range=start===end?`hacia las ${start}`:`entre ${start} y ${end}`;
    const level=(w.peakProb||0)>=75?'Alta probabilidad de lluvia':(w.peakProb||0)>=45?'Probabilidad de lluvia':'Posible lluvia';
    const amount=Number(w.totalMm)>0?` · ${Number(w.totalMm).toLocaleString('es-ES',{maximumFractionDigits:1})} mm aprox. en la franja`:'';
    return {headline:`${level} ${range}`,detail:`Pico: ${Math.round(w.peakProb||0)} % hacia las ${peak}${amount} · ${timing}.`};
  }
  function paintRainWindow(){
    const txt=rainWindowText(window.__smartMeta);if(!txt)return;
    const h=document.getElementById('rainHeadline'),d=document.getElementById('rainDetail');
    if(h&&h.textContent!==txt.headline)h.textContent=txt.headline;
    if(d&&d.textContent!==txt.detail)d.textContent=txt.detail;
  }
  function applyRainWindowUI(){
    paintRainWindow();
    const h=document.getElementById('rainHeadline'),d=document.getElementById('rainDetail');
    if((h||d)&&!window.__huracanRainWindowObserver){
      window.__huracanRainWindowObserver=new MutationObserver(()=>paintRainWindow());
      if(h)window.__huracanRainWindowObserver.observe(h,{childList:true,characterData:true,subtree:true});
      if(d)window.__huracanRainWindowObserver.observe(d,{childList:true,characterData:true,subtree:true});
    }
  }
  function applyAttribution(meta){
    const el=document.querySelector('.source-note');if(!el)return;
    const d=(meta?.smart?.deterministicSources||[]).length,e=(meta?.smart?.ensembleSources||[]).length,r=meta?.smart?.runHistory?.count||0;
    let txt='Previsión de consenso: Open-Meteo';if(d||e)txt+=` (${d} modelos + ${e} ensembles)`;if(r)txt+=` + ${r} ejecuciones anteriores de ECMWF`;if(meta?.smart?.radar?.available)txt+=' + radar RainViewer';txt+='. Avisos oficiales: AEMET.';
    el.textContent=txt;
    el.title='Huracán estabiliza los cambios entre actualizaciones y combina modelos deterministas, ensembles, ejecuciones anteriores y radar cuando están disponibles.';
  }

  window.fetch = async function(input,init){
    const url=typeof input==='string'?input:input?.url||'';
    if(url.startsWith(SMART_PREFIX)&&url.includes('forecast_days=7')){
      try{
        const u=new URL(url),lat=u.searchParams.get('latitude'),lon=u.searchParams.get('longitude');
        if(lat&&lon){
          const store=loadStore(),loc=key(lat,lon),bucket=bucketFor(store,loc),learned=buildWeights(bucket);
          const sp=new URLSearchParams({lat,lon,we:learned.det.ecmwf,wi:learned.det.icon,wg:learned.det.gfs,wm:learned.det.meteofrance,re:learned.rain.ecmwf,ri:learned.rain.icon,rg:learned.rain.gfs});
          const r=await nativeFetch(`/api/smart?${sp}`,{cache:'no-store'});
          if(r.ok){
            const payload=await r.json(),f=payload.forecast;
            if(f){
              verify(store,loc,f,payload.smart);
              const calibration=calibrateRain(bucket,f),stabilized=stabilizeForecast(bucket,f,payload.smart,payload.confidence);
              snapshot(bucket,f,payload.smart?.training);store[loc]=bucket;saveStore(store);
              window.__smartMeta={confidence:stabilized.confidence,smart:payload.smart,calibration,window:stabilized.window};
              queueMicrotask(()=>{applyConfidence(window.__smartMeta);applyAttribution(window.__smartMeta);applyRainWindowUI();});
              return new Response(JSON.stringify(f),{status:200,headers:{'Content-Type':'application/json','X-Huracan-Smart':'3'}});
            }
          }
        }
      }catch(e){console.warn('Huracán smart forecast fallback',e);}
    }
    return nativeFetch(input,init);
  };
})();
(function(){
  const previousFetch=window.fetch.bind(window);
  const FORECAST_PREFIX='https://api.open-meteo.com/v1/forecast?';
  function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function hourKey(t){return String(t||'').slice(0,13);}
  function recomputeDaily(f){
    const h=f.hourly||{},d=f.daily||{};if(!Array.isArray(h.time)||!Array.isArray(d.time))return;
    d.time.forEach((date,di)=>{const idx=[];h.time.forEach((t,i)=>{if(String(t).startsWith(date))idx.push(i);});if(!idx.length)return;
      const probs=idx.map(i=>n(h.precipitation_probability?.[i])).filter(Number.isFinite),prec=idx.map(i=>Math.max(0,n(h.precipitation?.[i])||0)),temps=idx.map(i=>n(h.temperature_2m?.[i])).filter(Number.isFinite);
      if(probs.length&&d.precipitation_probability_max)d.precipitation_probability_max[di]=Math.round(Math.max(...probs));
      if(prec.length&&d.precipitation_sum)d.precipitation_sum[di]=Math.round(prec.reduce((s,v)=>s+v,0)*10)/10;
      if(temps.length&&d.temperature_2m_max&&d.temperature_2m_min){d.temperature_2m_max[di]=Math.round(Math.max(...temps)*10)/10;d.temperature_2m_min[di]=Math.round(Math.min(...temps)*10)/10;}
    });
  }
  function blend(f,mb){
    const h=f.hourly||{},m=mb?.hourly||{};if(!Array.isArray(h.time)||!Array.isArray(m.time))return {used:false};
    const map=new Map(m.time.map((t,i)=>[hourKey(t),i]));
    const now=f.current?.time,nowIdx=Math.max(0,h.time.findIndex(t=>t>=now));let used=0,diffs=[];
    h.time.forEach((t,i)=>{
      if(i<nowIdx)return;const j=map.get(hourKey(t));if(j===undefined)return;
      const hours=i-nowIdx,mbP=n(m.precipitation_probability?.[j]),baseP=n(h.precipitation_probability?.[i]);
      const mbMm=n(m.precipitation?.[j]),baseMm=n(h.precipitation?.[i]);
      const mbT=n(m.temperature?.[j]),baseT=n(h.temperature_2m?.[i]);
      const mbF=n(m.apparent_temperature?.[j]),baseF=n(h.apparent_temperature?.[i]);
      const mbW=n(m.windspeed?.[j]),baseW=n(h.wind_speed_10m?.[i]);
      const rw=hours<=6?.18:hours<=24?.22:hours<=48?.18:.12;
      if(Number.isFinite(mbP)&&Number.isFinite(baseP)){diffs.push(Math.abs(mbP-baseP));h.precipitation_probability[i]=Math.round(clamp(baseP*(1-rw)+mbP*rw,0,100));used++;}
      if(Number.isFinite(mbMm)&&Number.isFinite(baseMm)){const w=hours<=24?.16:.10;h.precipitation[i]=Math.max(0,Math.round((baseMm*(1-w)+mbMm*w)*100)/100);}
      if(Number.isFinite(mbT)&&Number.isFinite(baseT)){const w=hours<=24?.10:.08;h.temperature_2m[i]=Math.round((baseT*(1-w)+mbT*w)*10)/10;}
      if(Number.isFinite(mbF)&&Number.isFinite(baseF)){const w=hours<=24?.10:.08;h.apparent_temperature[i]=Math.round((baseF*(1-w)+mbF*w)*10)/10;}
      if(Number.isFinite(mbW)&&Number.isFinite(baseW)){const w=.08;h.wind_speed_10m[i]=Math.max(0,Math.round((baseW*(1-w)+mbW*w)*10)/10);}
    });
    if(used)recomputeDaily(f);
    const agreement=diffs.length?Math.round(clamp(100-diffs.reduce((s,v)=>s+v,0)/diffs.length*1.4,0,100)):null;
    return {used:used>0,hours:used,agreement};
  }
  function annotate(meta){
    if(!meta?.meteoblue?.used)return;
    const el=document.querySelector('.source-note');if(!el)return;
    const base=el.textContent||'';if(!base.includes('meteoblue'))el.textContent=base.replace(/\.?\s*$/,'')+' + meteoblue.';
  }
  window.fetch=async function(input,init){
    const url=typeof input==='string'?input:input?.url||'';
    const response=await previousFetch(input,init);
    if(!url.startsWith(FORECAST_PREFIX)||!url.includes('forecast_days=7')||!response.ok)return response;
    try{
      const u=new URL(url),lat=u.searchParams.get('latitude'),lon=u.searchParams.get('longitude');if(!lat||!lon)return response;
      const f=await response.clone().json();
      const q=new URLSearchParams({lat:Number(lat).toFixed(3),lon:Number(lon).toFixed(3)});
      const mr=await previousFetch(`/api/meteoblue?${q}`,{cache:'no-store'});
      if(!mr.ok)return response;
      const mb=await mr.json(),result=blend(f,mb);if(!result.used)return response;
      window.__meteoblueMeta=result;
      window.__smartMeta=window.__smartMeta||{};window.__smartMeta.meteoblue=result;
      queueMicrotask(()=>annotate(window.__smartMeta));
      setTimeout(()=>annotate(window.__smartMeta),250);
      return new Response(JSON.stringify(f),{status:response.status,headers:{'Content-Type':'application/json','X-Huracan-Meteoblue':'1'}});
    }catch(e){console.warn('meteoblue consensus fallback',e);return response;}
  };
})();
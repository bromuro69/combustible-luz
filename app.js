const $ = (id) => document.getElementById(id);
let deferredPrompt = null;
let searchTimer = null;
let currentPlace = null;
let alertsRequestId = 0;

const GIJON = { name:'Gijón', admin1:'Asturias', country:'España', country_code:'ES', latitude:43.5322, longitude:-5.6611, timezone:'Europe/Madrid', manual:true };
const API = 'https://api.open-meteo.com/v1';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';

const weatherMap = {
  0:['Despejado','☀️'],1:['Casi despejado','🌤️'],2:['Parcialmente nuboso','⛅️'],3:['Nublado','☁️'],
  45:['Niebla','🌫️'],48:['Niebla','🌫️'],51:['Llovizna débil','🌦️'],53:['Llovizna','🌦️'],55:['Llovizna intensa','🌧️'],
  56:['Llovizna helada','🌧️'],57:['Llovizna helada','🌧️'],61:['Lluvia débil','🌦️'],63:['Lluvia','🌧️'],65:['Lluvia intensa','🌧️'],
  66:['Lluvia helada','🌧️'],67:['Lluvia helada','🌧️'],71:['Nieve débil','🌨️'],73:['Nieve','🌨️'],75:['Nieve intensa','❄️'],77:['Granizo de nieve','🌨️'],
  80:['Chubascos débiles','🌦️'],81:['Chubascos','🌧️'],82:['Chubascos fuertes','⛈️'],85:['Chubascos de nieve','🌨️'],86:['Nieve intensa','❄️'],
  95:['Tormenta','⛈️'],96:['Tormenta con granizo','⛈️'],99:['Tormenta fuerte','⛈️']
};
const PRECIP_CODES = new Set([51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99]);

function wx(code, isDay=1){
  const codeNum=Number(code);
  const day=Number(isDay)!==0;
  if(!day){
    if(codeNum===0)return ['Despejado','🌙'];
    if(codeNum===1)return ['Poco nuboso','🌙'];
    if(codeNum===2)return ['Parcialmente nuboso','🌙☁️'];
    if(codeNum===3)return ['Nublado','☁️'];
  }
  return weatherMap[codeNum] || ['Variable','☁️'];
}
function dryWx(cloudCover,isDay=1){
  const cloud=Number(cloudCover);
  const day=Number(isDay)!==0;
  if(Number.isFinite(cloud)){
    if(cloud>=80)return ['Nublado','☁️'];
    if(cloud>=45)return ['Parcialmente nuboso',day?'⛅️':'🌙☁️'];
    if(cloud>=20)return ['Poco nuboso',day?'🌤️':'🌙'];
  }
  return day?['Despejado','☀️']:['Despejado','🌙'];
}
function displayWx(code,isDay=1,probability=null,precipitation=null,cloudCover=null){
  const codeNum=Number(code);
  const prob=Number(probability);
  const mm=Number(precipitation);
  const veryLowChance=Number.isFinite(prob)&&prob<20;
  const negligibleRain=!Number.isFinite(mm)||mm<0.1;
  if(PRECIP_CODES.has(codeNum)&&veryLowChance&&negligibleRain)return dryWx(cloudCover,isDay);
  return wx(codeNum,isDay);
}
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#039;'}[c]));}
function fmt(n,d=0){return Number.isFinite(Number(n))?Number(n).toLocaleString('es-ES',{maximumFractionDigits:d,minimumFractionDigits:d}):'—';}
function hourOf(iso){return iso?.slice(11,16)||'—';}
function dayName(iso,i){if(i===0)return'Hoy';if(i===1)return'Mañana';return new Intl.DateTimeFormat('es-ES',{weekday:'short'}).format(new Date(`${iso}T12:00:00`)).replace('.','').replace(/^./,c=>c.toUpperCase());}
function dateShort(iso){return new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short'}).format(new Date(`${iso}T12:00:00`)).replace('.','');}
function saveRecent(place){ if(!place?.manual)return; const old=JSON.parse(localStorage.getItem('weatherRecents')||'[]'); const next=[place,...old.filter(x=>!(x.name===place.name&&x.admin1===place.admin1))].slice(0,5); localStorage.setItem('weatherRecents',JSON.stringify(next)); renderRecents(); }
function renderRecents(){const list=JSON.parse(localStorage.getItem('weatherRecents')||'[]');$('recentWrap').classList.toggle('hidden',!list.length);$('recentList').innerHTML=list.map((p,i)=>`<button class="recent-item" data-recent="${i}">🕘 <span><strong>${esc(p.name)}</strong><small>${esc([p.admin1,p.country].filter(Boolean).join(', '))}</small></span></button>`).join('');document.querySelectorAll('[data-recent]').forEach(b=>b.onclick=()=>selectPlace(list[Number(b.dataset.recent)]));}

function setStatus(text=''){ $('status').textContent=text; $('status').classList.toggle('hidden',!text); }
function setLoading(on){$('refreshBtn').classList.toggle('loading',on);$('refreshBtn').disabled=on;}
function placeLabel(p){return p?.name || 'Mi ubicación';}
function selectPlace(place){ currentPlace={...place}; $('placeIcon').textContent=place.manual?'🔎':'📍'; $('placeName').textContent=placeLabel(place); $('searchPanel').classList.add('hidden'); $('searchInput').value=''; $('searchResults').innerHTML=''; $('aemetAlerts').classList.add('hidden'); saveRecent(place); loadWeather(place); }

async function getForecast(place){
  const q=new URLSearchParams({latitude:place.latitude,longitude:place.longitude,timezone:'auto',forecast_days:'7',current:'temperature_2m,apparent_temperature,is_day,weather_code,cloud_cover,wind_speed_10m,precipitation',hourly:'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,is_day,wind_speed_10m,cloud_cover',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max'});
  const r=await fetch(`${API}/forecast?${q}`); if(!r.ok)throw new Error('No se pudo obtener la previsión'); return r.json();
}
async function getModel(endpoint,place){
  const q=new URLSearchParams({latitude:place.latitude,longitude:place.longitude,timezone:'auto',forecast_days:'2',current:'temperature_2m,weather_code',hourly:'temperature_2m,precipitation'});
  const r=await fetch(`${API}/${endpoint}?${q}`); if(!r.ok)throw new Error(endpoint); return r.json();
}
async function getAlerts(place){
  const q=new URLSearchParams({lat:String(place.latitude),lon:String(place.longitude)});
  const r=await fetch(`/api/alerts?${q}`,{cache:'no-store'});
  if(!r.ok)throw new Error('AEMET no disponible');
  return r.json();
}
function alertIcon(event=''){
  const s=String(event).toLowerCase();
  if(s.includes('viento'))return'💨';
  if(s.includes('lluv')||s.includes('precipit'))return'🌧️';
  if(s.includes('nieve')||s.includes('nevad'))return'❄️';
  if(s.includes('torment'))return'⛈️';
  if(s.includes('calor')||s.includes('temperatura'))return'🌡️';
  if(s.includes('costa')||s.includes('mar')||s.includes('oleaje'))return'🌊';
  if(s.includes('niebla'))return'🌫️';
  return'⚠️';
}
function alertMoment(iso){
  if(!iso)return'';
  const d=new Date(iso);if(Number.isNaN(d.getTime()))return'';
  return new Intl.DateTimeFormat('es-ES',{weekday:'short',hour:'2-digit',minute:'2-digit'}).format(d).replace('.','');
}
function renderAlerts(data){
  const card=$('aemetAlerts');
  const alerts=Array.isArray(data?.alerts)?data.alerts:[];
  if(!alerts.length){card.classList.add('hidden');$('alertsList').innerHTML='';return;}
  $('alertsCount').textContent=`${alerts.length} ${alerts.length===1?'activo':'activos'}`;
  $('alertsList').innerHTML=alerts.map(a=>{
    const start=alertMoment(a.onset),end=alertMoment(a.expires);
    const timeText=start&&end?`${start} → ${end}`:start||end||'';
    const probability=a.probability?`<span>🎯 ${esc(a.probability)}</span>`:'';
    const detail=a.detail?`<p class="alert-detail">${esc(a.detail)}</p>`:'';
    return `<article class="alert-item level-${esc(a.level)}"><div class="alert-top"><span class="alert-icon">${alertIcon(a.event)}</span><div class="alert-title"><span class="alert-level">Aviso ${esc(a.level)}</span><strong>${esc(a.event)}</strong></div></div><p class="alert-zone">${esc(a.area)}</p><div class="alert-meta">${timeText?`<span>🕒 ${esc(timeText)}</span>`:''}${probability}</div>${detail}</article>`;
  }).join('');
  card.classList.remove('hidden');
}
async function loadAlerts(place){
  const requestId=++alertsRequestId;
  try{
    const data=await getAlerts(place);
    if(requestId!==alertsRequestId)return;
    renderAlerts(data);
  }catch{
    if(requestId===alertsRequestId)$('aemetAlerts').classList.add('hidden');
  }
}

function renderMain(data){
  const c=data.current||{};
  const h=data.hourly||{};
  const nowIndex=Math.max(0,(h.time||[]).findIndex(t=>t>=data.current?.time));
  const currentProb=h.precipitation_probability?.[nowIndex];
  const [text,icon]=displayWx(c.weather_code,c.is_day,currentProb,c.precipitation,c.cloud_cover);
  $('currentTemp').textContent=fmt(c.temperature_2m); $('currentText').textContent=text; $('currentIcon').textContent=icon;
  $('feelsLike').textContent=`Sensación ${fmt(c.apparent_temperature)}°`;
  $('currentRain').textContent=`${fmt(c.precipitation,1)} mm`; $('currentWind').textContent=`${fmt(c.wind_speed_10m)} km/h`; $('currentCloud').textContent=`${fmt(c.cloud_cover)} %`;

  const indexes=Array.from({length:24},(_,i)=>nowIndex+i).filter(i=>i<(h.time||[]).length);
  $('hourlyStrip').innerHTML=indexes.map((i,k)=>{
    const probability=Number(h.precipitation_probability?.[i])||0;
    const [_,ic]=displayWx(h.weather_code[i],h.is_day?.[i],probability,h.precipitation?.[i],h.cloud_cover?.[i]);
    const rawMm=Number(h.precipitation?.[i]);
    const mm=Number.isFinite(rawMm)?Math.max(0,rawMm):0;
    const rainAmount=mm>0?`<span class="rain-mm" style="margin-top:6px">💧 ${fmt(mm,mm<0.1?2:1)} mm</span>`:'';
    return `<div class="hour-card ${k===0?'now':''}"><span class="time">${k===0?'Ahora':hourOf(h.time[i])}</span><div class="icon">${ic}</div><strong>${fmt(h.temperature_2m[i])}°</strong><span class="feels" title="Sensación térmica">✋ ${fmt(h.apparent_temperature?.[i])}°</span><span class="rain">☔ ${fmt(probability)}%</span>${rainAmount}</div>`;
  }).join('');

  const d=data.daily||{};
  $('dailyList').innerHTML=(d.time||[]).map((date,i)=>{
    const [_,ic]=wx(d.weather_code[i],1);
    const rainProb=Number(d.precipitation_probability_max?.[i])||0;
    const rainMm=Math.max(0,Number(d.precipitation_sum?.[i])||0);
    const wind=Math.max(0,Number(d.wind_speed_10m_max?.[i])||0);
    const mmDigits=rainMm>0&&rainMm<0.1?2:1;
    return `<div class="day-row">
      <div class="day-main"><span class="day">${dayName(date,i)}</span><span class="date">${dateShort(date)}</span></div>
      <span class="day-icon">${ic}</span>
      <div class="day-metrics">
        <span>☔ ${fmt(rainProb)}%</span>
        <span>💧 ${fmt(rainMm,mmDigits)} mm</span>
        <span>💨 ${fmt(wind)} km/h</span>
      </div>
      <div class="temps"><strong>${fmt(d.temperature_2m_max[i])}°</strong><span class="min">${fmt(d.temperature_2m_min[i])}°</span></div>
    </div>`;
  }).join('');
  renderRain(data,nowIndex);
}

function renderRain(data,nowIndex){
  const h=data.hourly||{};
  const end=Math.min(nowIndex+24,(h.time||[]).length);
  const times=(h.time||[]).slice(nowIndex,end);
  const probs=times.map((_,i)=>{
    const raw=h.precipitation_probability?.[nowIndex+i];
    return raw===null||raw===undefined?null:Number(raw);
  });
  const valid=probs.map((p,i)=>({p,i})).filter(x=>Number.isFinite(x.p));
  if(!valid.length){
    $('rainHeadline').textContent='Previsión de lluvia no disponible';
    $('rainDetail').textContent='Vuelve a actualizar para consultar las próximas 24 h.';
    return;
  }
  const {p:peak,i:peakIndex}=valid.reduce((best,x)=>x.p>best.p?x:best);
  const amounts=times.map((_,i)=>Math.max(0,Number(h.precipitation?.[nowIndex+i])||0));
  const total=amounts.reduce((sum,mm)=>sum+mm,0);
  const peakMm=amounts[peakIndex];
  const hour=hourOf(times[peakIndex]);
  let headline;
  if(peak<30)headline=total<0.1?'Sin lluvia prevista en las próximas 24 h':`Lluvia poco probable hacia las ${hour}`;
  else if(peak<45)headline=`Probabilidad baja de lluvia hacia las ${hour}`;
  else if(peak<75)headline=`Probabilidad de lluvia hacia las ${hour}`;
  else headline=`Alta probabilidad de lluvia hacia las ${hour}`;
  $('rainHeadline').textContent=headline;
  const amount=peakMm>0?` · ${fmt(peakMm,peakMm<0.1?2:1)} mm previstos en esa hora`:total>=0.1?` · ${fmt(total,total<1?2:1)} mm previstos en 24 h`:'';
  $('rainDetail').textContent=`Probabilidad máxima: ${fmt(peak)} % a las ${hour}${amount}.`;
}

function updateRainConfidence(models){
  const ok=models.filter(x=>x.status==='fulfilled').map(x=>x.value);
  let level='medium',label='media';
  if(ok.length>=2){
    const temps=ok.map(m=>Number(m.current?.temperature_2m)).filter(Number.isFinite);
    const tempSpread=temps.length?Math.max(...temps)-Math.min(...temps):0;
    const sums=ok.map(m=>(m.hourly?.precipitation||[]).slice(0,24).reduce((a,b)=>a+(Number(b)||0),0));
    const rainSpread=sums.length?Math.max(...sums)-Math.min(...sums):0;
    const rainy=sums.filter(v=>v>=0.5).length;
    level='high'; label='alta';
    if(tempSpread>3||rainSpread>4||(rainy>0&&rainy<ok.length)){level='medium';label='media';}
    if(tempSpread>5||rainSpread>8){level='low';label='baja';}
  }
  $('rainConfidence').className=`confidence ${level}`;
  $('rainConfidence').textContent=`Confianza ${label}`;
}

async function loadWeather(place=currentPlace){
  if(!place)return; setLoading(true); setStatus(''); $('weatherContent').classList.remove('hidden');
  try{
    const main=await getForecast(place); renderMain(main); loadAlerts(place);
    const models=await Promise.allSettled(['ecmwf','dwd-icon','gfs'].map(e=>getModel(e,place)));
    updateRainConfidence(models);
    $('lastUpdated').textContent=`Actualizado ${new Date().toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`;
  }catch(e){setStatus(`No se pudo actualizar el tiempo: ${e.message}`);}finally{setLoading(false);}
}

function locate(){
  setStatus(''); $('placeIcon').textContent='📍'; $('placeName').textContent='Localizando…';
  if(!navigator.geolocation){selectPlace(GIJON);setStatus('Este navegador no permite geolocalización. Mostramos Gijón.');return;}
  navigator.geolocation.getCurrentPosition(pos=>selectPlace({name:'Mi ubicación',latitude:pos.coords.latitude,longitude:pos.coords.longitude,manual:false}),()=>{selectPlace(GIJON);setStatus('No pudimos acceder a tu ubicación. Mostramos Gijón; puedes buscar otro lugar arriba.');},{enableHighAccuracy:false,timeout:7000,maximumAge:10*60*1000});
}

async function searchPlaces(q){
  if(q.trim().length<2){$('searchResults').innerHTML='';return;}
  try{const u=new URL(GEO);u.searchParams.set('name',q.trim());u.searchParams.set('count','6');u.searchParams.set('language','es');const r=await fetch(u);const j=await r.json();const rs=j.results||[];$('searchResults').innerHTML=rs.map((p,i)=>`<button class="search-result" data-result="${i}">📌 <span><strong>${esc(p.name)}</strong><small>${esc([p.admin1,p.country].filter(Boolean).join(', '))}</small></span></button>`).join('')||'<p class="subtle" style="padding:10px">No encontramos ese lugar.</p>';document.querySelectorAll('[data-result]').forEach(b=>b.onclick=()=>{const p=rs[Number(b.dataset.result)];selectPlace({...p,manual:true});});}catch{$('searchResults').innerHTML='<p class="subtle" style="padding:10px">No se pudo realizar la búsqueda.</p>';}
}

$('placeBtn').onclick=()=>{$('searchPanel').classList.toggle('hidden');if(!$('searchPanel').classList.contains('hidden')){renderRecents();setTimeout(()=>$('searchInput').focus(),50);}};
$('searchInput').addEventListener('input',e=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>searchPlaces(e.target.value),260);});
$('myLocationBtn').onclick=()=>{$('searchPanel').classList.add('hidden');locate();};
$('refreshBtn').onclick=()=>loadWeather();
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;});
$('installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;return;}if(/iPhone|iPad|iPod/i.test(navigator.userAgent))$('iosInstallDialog').showModal();else alert('Abre el menú del navegador y selecciona “Instalar aplicación” o “Añadir a pantalla de inicio”.');};
$('closeDialog').onclick=()=>$('iosInstallDialog').close();
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
renderRecents();locate();

const $ = (id) => document.getElementById(id);
let deferredPrompt = null;
let searchTimer = null;
let currentPlace = null;

const GIJON = { name:'Gijón', admin1:'Asturias', country:'España', latitude:43.5322, longitude:-5.6611, timezone:'Europe/Madrid', manual:true };
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
  const item = weatherMap[Number(code)] || ['Variable','☁️'];
  if(Number(code)===0 && !Number(isDay)) return ['Despejado','🌙'];
  if(Number(code)===1 && !Number(isDay)) return ['Poco nuboso','🌙'];
  return item;
}
function dryWx(cloudCover,isDay=1){
  const cloud=Number(cloudCover);
  if(Number.isFinite(cloud)){
    if(cloud>=80)return ['Nublado','☁️'];
    if(cloud>=45)return ['Parcialmente nuboso',Number(isDay)?'⛅️':'☁️'];
    if(cloud>=20)return ['Poco nuboso',Number(isDay)?'🌤️':'🌙'];
  }
  return Number(isDay)?['Despejado','☀️']:['Despejado','🌙'];
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
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function fmt(n,d=0){return Number.isFinite(Number(n))?Number(n).toLocaleString('es-ES',{maximumFractionDigits:d,minimumFractionDigits:d}):'—';}
function hourOf(iso){return iso?.slice(11,16)||'—';}
function dayName(iso,i){if(i===0)return'Hoy';if(i===1)return'Mañana';return new Intl.DateTimeFormat('es-ES',{weekday:'short'}).format(new Date(`${iso}T12:00:00`)).replace('.','').replace(/^./,c=>c.toUpperCase());}
function saveRecent(place){ if(!place?.manual)return; const old=JSON.parse(localStorage.getItem('weatherRecents')||'[]'); const next=[place,...old.filter(x=>!(x.name===place.name&&x.admin1===place.admin1))].slice(0,5); localStorage.setItem('weatherRecents',JSON.stringify(next)); renderRecents(); }
function renderRecents(){const list=JSON.parse(localStorage.getItem('weatherRecents')||'[]');$('recentWrap').classList.toggle('hidden',!list.length);$('recentList').innerHTML=list.map((p,i)=>`<button class="recent-item" data-recent="${i}">🕘 <span><strong>${esc(p.name)}</strong><small>${esc([p.admin1,p.country].filter(Boolean).join(', '))}</small></span></button>`).join('');document.querySelectorAll('[data-recent]').forEach(b=>b.onclick=()=>selectPlace(list[Number(b.dataset.recent)]));}

function setStatus(text=''){ $('status').textContent=text; $('status').classList.toggle('hidden',!text); }
function setLoading(on){$('refreshBtn').classList.toggle('loading',on);$('refreshBtn').disabled=on;}
function placeLabel(p){return p?.name || 'Mi ubicación';}
function selectPlace(place){ currentPlace={...place}; $('placeIcon').textContent=place.manual?'🔎':'📍'; $('placeName').textContent=placeLabel(place); $('searchPanel').classList.add('hidden'); $('searchInput').value=''; $('searchResults').innerHTML=''; saveRecent(place); loadWeather(place); }

async function getForecast(place){
  const q=new URLSearchParams({latitude:place.latitude,longitude:place.longitude,timezone:'auto',forecast_days:'7',current:'temperature_2m,apparent_temperature,is_day,weather_code,cloud_cover,wind_speed_10m,precipitation',hourly:'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,is_day,wind_speed_10m,cloud_cover',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum'});
  const r=await fetch(`${API}/forecast?${q}`); if(!r.ok)throw new Error('No se pudo obtener la previsión'); return r.json();
}
async function getModel(endpoint,place){
  const q=new URLSearchParams({latitude:place.latitude,longitude:place.longitude,timezone:'auto',forecast_days:'2',current:'temperature_2m,weather_code',hourly:'temperature_2m,precipitation'});
  const r=await fetch(`${API}/${endpoint}?${q}`); if(!r.ok)throw new Error(endpoint); return r.json();
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

  const indexes=Array.from({length:12},(_,i)=>nowIndex+i).filter(i=>i<(h.time||[]).length);
  $('hourlyStrip').innerHTML=indexes.map((i,k)=>{const [_,ic]=displayWx(h.weather_code[i],h.is_day?.[i],h.precipitation_probability?.[i],h.precipitation?.[i],h.cloud_cover?.[i]);return `<div class="hour-card ${k===0?'now':''}"><span class="time">${k===0?'Ahora':hourOf(h.time[i])}</span><div class="icon">${ic}</div><strong>${fmt(h.temperature_2m[i])}°</strong><span class="rain">💧 ${fmt(h.precipitation_probability[i])}%</span></div>`}).join('');

  const d=data.daily||{};
  $('dailyList').innerHTML=(d.time||[]).map((date,i)=>{const [_,ic]=wx(d.weather_code[i],1);return `<div class="day-row"><span class="day">${dayName(date,i)}</span><span>${ic}</span><span class="rain">💧 ${fmt(d.precipitation_probability_max[i])}% · ${fmt(d.precipitation_sum[i],1)} mm</span><span class="temps"><strong>${fmt(d.temperature_2m_max[i])}°</strong> <span class="min">${fmt(d.temperature_2m_min[i])}°</span></span></div>`}).join('');
  renderRain(data,nowIndex);
}

function renderRain(data,nowIndex){
  const h=data.hourly||{};
  const end=Math.min(nowIndex+12,(h.time||[]).length);
  const probs=(h.precipitation_probability||[]).slice(nowIndex,end).map(v=>Number(v)||0);
  const times=(h.time||[]).slice(nowIndex,end);
  const peak=Math.max(0,...probs);
  const first20=probs.findIndex(p=>p>=20);
  const first40=probs.findIndex(p=>p>=40);
  const first70=probs.findIndex(p=>p>=70);

  if(peak<20){
    $('rainHeadline').textContent='Sin lluvia prevista en las próximas horas';
  }else if(peak<40){
    $('rainHeadline').textContent=`Baja posibilidad de lluvia desde las ${hourOf(times[first20])}`;
  }else if(peak<70){
    $('rainHeadline').textContent=`Posible lluvia desde las ${hourOf(times[first40])}`;
  }else{
    $('rainHeadline').textContent=`Lluvia probable desde las ${hourOf(times[first70])}`;
  }
  $('rainDetail').textContent=`Probabilidad máxima aproximada: ${fmt(peak)} %.`;
  $('rainBars').innerHTML=probs.map((p,i)=>`<div class="rain-col"><div class="rain-bar" style="height:${Math.max(3,p*.62)}px;opacity:${.35+p/160}"></div><small>${hourOf(times[i]).slice(0,2)}</small></div>`).join('');
}

function updateRainConfidence(models){
  const ok=models.filter(x=>x.status==='fulfilled').map(x=>x.value);
  let level='medium',label='media';
  if(ok.length>=2){
    const temps=ok.map(m=>Number(m.current?.temperature_2m)).filter(Number.isFinite);
    const tempSpread=temps.length?Math.max(...temps)-Math.min(...temps):0;
    const sums=ok.map(m=>(m.hourly?.precipitation||[]).slice(0,12).reduce((a,b)=>a+(Number(b)||0),0));
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
    const main=await getForecast(place); renderMain(main);
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
const $ = (id) => document.getElementById(id);
let deferredPrompt = null;
let searchTimer = null;
let searchOrigin = null;

const PRODUCT_NAMES = { g95: 'Gasolina 95', g98: 'Gasolina 98', diesel: 'Gasóleo A' };
const FUEL_CONFIG_KEY = 'energiasFuelConfigV1';
const DEFAULT_FUEL_CONFIG = { mode:'station', radius:10, station:{ id:'886', brand:'EASYGAS', address:'Roces · Gijón' } };

function madridHour() {
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(parts.find(p => p.type === 'hour')?.value ?? new Date().getHours()) % 24;
}
function hasNumber(n) { return n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n)); }
function fmtPrice(n) { return hasNumber(n) ? Number(n).toLocaleString('es-ES', { minimumFractionDigits: 5, maximumFractionDigits: 5 }) : '—'; }
function fmtFuel(n) { return hasNumber(n) ? Number(n).toLocaleString('es-ES', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : '—'; }
function fmtMoney(n) { return hasNumber(n) ? Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
function fmtGasVariable(n) { return hasNumber(n) ? Number(n).toLocaleString('es-ES', { minimumFractionDigits: 6, maximumFractionDigits: 6 }) : '—'; }
function hourLabel(h) { return `${String(h).padStart(2, '0')}:00`; }
function hourRange(h) { return `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`; }
function rankClass(rank) { return rank < 8 ? 'green' : rank < 16 ? 'orange' : 'red'; }
function rankEmoji(rank) { return rank < 8 ? '🟢' : rank < 16 ? '🟠' : '🔴'; }
function escapeHtml(str='') { return String(str).replace(/[&<>'\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','\"':'&quot;'}[ch])); }

function getFuelConfig() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FUEL_CONFIG_KEY) || 'null');
    if (!parsed) return structuredClone(DEFAULT_FUEL_CONFIG);
    const radius = [5,10,15,25].includes(Number(parsed.radius)) ? Number(parsed.radius) : 10;
    if (parsed.mode === 'location' && hasNumber(parsed.lat) && hasNumber(parsed.lon)) return {mode:'location',radius,lat:Number(parsed.lat),lon:Number(parsed.lon)};
    if (parsed.station?.id) return {mode:'station',radius,station:parsed.station};
  } catch {}
  return structuredClone(DEFAULT_FUEL_CONFIG);
}
function saveFuelConfig(config) { localStorage.setItem(FUEL_CONFIG_KEY, JSON.stringify(config)); }
function fuelQuery(force=false) {
  const c=getFuelConfig();
  const p=new URLSearchParams();
  p.set('radius', String(c.radius));
  if (c.mode === 'location') {
    p.set('mode','location'); p.set('lat',String(c.lat)); p.set('lon',String(c.lon));
  } else {
    p.set('mode','station'); p.set('stationId',String(c.station?.id || '886'));
  }
  if (force) p.set('t',String(Date.now()));
  return p.toString();
}

function renderElectricity(data) {
  const hours = [...data.hours].sort((a,b) => a.hora - b.hora);
  const sorted = [...hours].sort((a,b) => a.pvpc - b.pvpc);
  const rankMap = new Map(sorted.map((x, i) => [x.hora, i]));
  const nowHour = madridHour();
  const current = hours.find(x => Number(x.hora) === nowHour) || hours[0];
  const currentRank = rankMap.get(current.hora) ?? 12;
  const nextCheap = hours.find(x => Number(x.hora) > nowHour && (rankMap.get(x.hora) ?? 99) < 8);

  $('currentPrice').textContent = fmtPrice(current.pvpc);
  $('currentHour').textContent = hourRange(current.hora);
  $('currentDot').className = `dot ${rankClass(currentRank)}`;
  if (nextCheap) {
    $('nextCheapHour').textContent = hourLabel(nextCheap.hora);
    $('nextCheapPrice').textContent = `${fmtPrice(nextCheap.pvpc)} €/kWh`;
  } else {
    $('nextCheapHour').textContent = '—';
    $('nextCheapPrice').textContent = 'No quedan horas baratas hoy';
  }
  $('top3').innerHTML = sorted.slice(0,3).map((x,i)=>`<div class="top-item best-item"><span>${['1ª','2ª','3ª'][i]} mejor</span><strong>${hourLabel(x.hora)}</strong><span>${fmtPrice(x.pvpc)} €/kWh</span></div>`).join('');
  $('worst3').innerHTML = [...sorted].reverse().slice(0,3).map((x,i)=>`<div class="top-item worst-item"><span>${['1ª','2ª','3ª'][i]} más cara</span><strong>${hourLabel(x.hora)}</strong><span>${fmtPrice(x.pvpc)} €/kWh</span></div>`).join('');
  $('hourlyList').innerHTML = hours.map(x => `<div class="price-row ${x.hora===nowHour?'current':''}"><span class="time">${hourLabel(x.hora)}</span><span>${rankEmoji(rankMap.get(x.hora))}</span><span class="price">${fmtPrice(x.pvpc)} €/kWh</span></div>`).join('');
  $('rankingList').innerHTML = sorted.map((x,rank)=>`<div class="price-row ${x.hora===nowHour?'current':''}"><span class="time">${hourLabel(x.hora)}</span><span><span class="rank-dot ${rankClass(rank)}" style="display:inline-block;margin-right:8px"></span>${rank<8?'Barata':rank<16?'Media':'Cara'}</span><span class="price">${fmtPrice(x.pvpc)} €/kWh</span></div>`).join('');
  const vals = hours.map(x=>Number(x.pvpc)); const min=Math.min(...vals), max=Math.max(...vals), span=Math.max(max-min,.001);
  $('hourlyChart').innerHTML = hours.map(x=>{ const rank=rankMap.get(x.hora); const pct=18+((Number(x.pvpc)-min)/span)*82; return `<div class="chart-bar ${rankClass(rank)} ${x.hora===nowHour?'current':''}" style="height:${pct}%" title="${hourLabel(x.hora)} · ${fmtPrice(x.pvpc)} €/kWh"></div>`; }).join('');
}

function renderFuel(data) {
  const config=getFuelConfig();
  const ref=data.reference || {};
  const prices=data.referencePrices || {};
  const stationMode=data.mode !== 'location';
  $('referenceEyebrow').textContent = stationMode ? 'MI GASOLINERA' : 'REFERENCIA';
  $('referenceName').textContent = ref.brand || (stationMode ? 'Mi gasolinera' : 'Tu ubicación actual');
  const place=[ref.address,ref.locality||ref.municipality,ref.province].filter(Boolean).join(' · ');
  $('referenceAddress').textContent = place;
  $('fuelUpdated').textContent = data.updatedLabel || 'Actualizado';
  $('cheapestRadiusLabel').textContent = `MÁS BARATO A ${data.radiusKm || config.radius} KM`;

  if (hasNumber(ref.lat) && hasNumber(ref.lon)) searchOrigin={lat:Number(ref.lat),lon:Number(ref.lon)};
  else if (config.mode==='location' && hasNumber(config.lat) && hasNumber(config.lon)) searchOrigin={lat:Number(config.lat),lon:Number(config.lon)};

  $('referenceFuelGrid').classList.toggle('hidden', !stationMode);
  $('locationReferenceNote').classList.toggle('hidden', stationMode);
  if (stationMode) {
    $('referenceFuelGrid').innerHTML = ['g95','g98','diesel'].map(key => {
      const price=prices[key]?.price;
      const priceHtml=hasNumber(price) ? `<strong>${fmtFuel(price)} <small>€/l</small></strong>` : `<strong class="no-price">Sin precio comunicado</strong>`;
      return `<div class="fuel-price"><span class="name">${PRODUCT_NAMES[key]}</span>${priceHtml}</div>`;
    }).join('');
  }

  $('cheapestFuel').innerHTML = ['g95','g98','diesel'].map(key => {
    const s=data.cheapest?.[key];
    if (!s) return `<div class="station-card"><div class="station-top"><span>${PRODUCT_NAMES[key]}</span><strong>—</strong></div><p>No hay estaciones con este combustible dentro del radio elegido.</p></div>`;
    const basePrice=prices[key]?.price;
    const saving=stationMode && hasNumber(basePrice) && hasNumber(s.price) ? Number(basePrice)-Number(s.price) : 0;
    let savingHtml='';
    if (stationMode && s.id && ref.id && s.id===ref.id) {
      savingHtml=`<div class="saving"><span>✓ Tu estación ya tiene el mejor precio</span><strong>Dentro de ${data.radiusKm} km</strong></div>`;
    } else if (saving > 0.0005) {
      savingHtml=`<div class="saving"><span>Ahorras frente a ${escapeHtml(ref.brand||'tu estación')}</span><strong>${fmtFuel(saving)} €/l · ${fmtMoney(saving*50)} € en 50 L</strong></div>`;
    }
    const address=[s.address,s.locality||s.municipality,s.province].filter(Boolean).join(' · ');
    const distance=hasNumber(s.distanceKm) ? `<span class="distance-pill">📍 ${Number(s.distanceKm).toLocaleString('es-ES',{maximumFractionDigits:1})} km</span>` : '';
    return `<div class="station-card"><div class="station-top"><span>${PRODUCT_NAMES[key]}</span><strong>${fmtFuel(s.price)} €/l</strong></div><h3>${escapeHtml(s.brand||'Estación de servicio')}</h3><p>${escapeHtml(address)}</p>${distance}${savingHtml}</div>`;
  }).join('');
}

function renderGas(data) {
  const tariffs = Array.isArray(data.tariffs) ? data.tariffs : [];
  $('gasPeriod').textContent = data.periodLabel || 'Tarifa vigente';
  $('gasGrid').innerHTML = tariffs.map(t => `<article class="gas-card"><div class="gas-card-head"><div><span class="card-label">${escapeHtml(t.id)}</span><h3>${escapeHtml(t.consumption)}</h3></div></div><div class="gas-main-price"><strong>${fmtGasVariable(t.variablePerKwh)}</strong><span>€/kWh</span></div><p class="gas-caption">Término variable</p><div class="gas-fixed"><span>Fijo mensual</span><strong>${fmtMoney(t.fixedMonthly)} €/mes</strong></div></article>`).join('');
  const notice = $('gasNotice');
  if (data.validUntil) {
    const expires = new Date(`${data.validUntil}T23:59:59+02:00`).getTime();
    const expired = Number.isFinite(expires) && Date.now() > expires;
    notice.classList.toggle('hidden', !expired);
    if (expired) notice.textContent = 'Esta TUR ha terminado su periodo de vigencia. Estamos pendientes de cargar la siguiente tarifa oficial publicada en el BOE.';
  } else notice.classList.add('hidden');
  const sourceLink = $('gasSourceLink');
  if (data.sourceUrl) { sourceLink.href=data.sourceUrl; sourceLink.classList.remove('hidden'); }
  else sourceLink.classList.add('hidden');
}

async function loadData(force=false) {
  $('status').classList.add('hidden'); $('refreshBtn').classList.add('loading'); $('refreshBtn').disabled=true;
  try {
    const res = await fetch(`/api/dashboard?${fuelQuery(force)}`, { cache: force ? 'no-store' : 'default' });
    if (!res.ok) { const body=await res.json().catch(()=>({})); throw new Error(body.detail || `Error ${res.status}`); }
    const payload = await res.json();
    if (!payload.electricity?.hours?.length) throw new Error('No se recibieron precios de electricidad.');
    renderFuel(payload.fuel||{}); renderElectricity(payload.electricity); renderGas(payload.gas||{});
    const ts=new Date(payload.generatedAt||Date.now()); $('lastUpdated').textContent=`Actualizado ${ts.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`;
    updateSettingsSummary();
  } catch(err) { $('status').textContent=`No se pudieron actualizar los datos: ${err.message}`; $('status').classList.remove('hidden'); }
  finally { $('refreshBtn').classList.remove('loading'); $('refreshBtn').disabled=false; }
}

function updateSettingsSummary() {
  const c=getFuelConfig();
  $('radiusSelect').value=String(c.radius);
  if (c.mode==='location') $('currentFuelSetting').textContent=`Referencia actual: tu ubicación · radio ${c.radius} km`;
  else $('currentFuelSetting').textContent=`Referencia actual: ${c.station?.brand||'Mi gasolinera'} · radio ${c.radius} km`;
}
function openFuelSettings() {
  $('stationSearch').value=''; $('stationResults').innerHTML=''; $('stationSearchStatus').textContent='';
  updateSettingsSummary(); $('fuelSettingsDialog').showModal();
}
function chooseStation(station) {
  const c=getFuelConfig();
  saveFuelConfig({mode:'station',radius:c.radius,station});
  if (hasNumber(station.lat) && hasNumber(station.lon)) searchOrigin={lat:Number(station.lat),lon:Number(station.lon)};
  $('fuelSettingsDialog').close();
  loadData(true);
}
async function searchStations(q) {
  const status=$('stationSearchStatus'), results=$('stationResults');
  if (q.trim().length<2) { status.textContent='Escribe al menos 2 caracteres.'; results.innerHTML=''; return; }
  status.textContent='Buscando…'; results.innerHTML='';
  try {
    const params=new URLSearchParams({q:q.trim()});
    if (searchOrigin && hasNumber(searchOrigin.lat) && hasNumber(searchOrigin.lon)) {
      params.set('lat',String(searchOrigin.lat)); params.set('lon',String(searchOrigin.lon));
    }
    const r=await fetch(`/api/stations?${params.toString()}`);
    if (!r.ok) throw new Error('No se pudo completar la búsqueda');
    const data=await r.json(); const stations=data.stations||[];
    status.textContent=stations.length ? `${stations.length} resultados${data.sortedByDistance?' · por cercanía':''}` : 'No encontramos estaciones. Prueba con otra localidad o dirección.';
    results.innerHTML=stations.map((s,i)=>{
      const distance=hasNumber(s.distanceKm) ? ` · ${Number(s.distanceKm).toLocaleString('es-ES',{maximumFractionDigits:1})} km` : '';
      const place=[s.address,s.locality||s.municipality,s.province].filter(Boolean).join(' · ');
      return `<button class="station-result" type="button" data-index="${i}"><strong>${escapeHtml(s.brand||'Estación de servicio')}</strong><span>${escapeHtml(place)}${escapeHtml(distance)}</span></button>`;
    }).join('');
    results.querySelectorAll('.station-result').forEach(btn=>btn.addEventListener('click',()=>chooseStation(stations[Number(btn.dataset.index)])));
  } catch(err) { status.textContent=err.message; }
}

$('fuelSettingsBtn').addEventListener('click',openFuelSettings);
$('closeFuelSettings').addEventListener('click',()=>$('fuelSettingsDialog').close());
$('stationSearch').addEventListener('input',e=>{ clearTimeout(searchTimer); const q=e.target.value; searchTimer=setTimeout(()=>searchStations(q),350); });
$('radiusSelect').addEventListener('change',e=>{
  const c=getFuelConfig(); c.radius=Number(e.target.value); saveFuelConfig(c); updateSettingsSummary(); loadData(true);
});
$('useLocationBtn').addEventListener('click',()=>{
  const btn=$('useLocationBtn');
  if (!navigator.geolocation) { $('stationSearchStatus').textContent='Este dispositivo no permite obtener la ubicación.'; return; }
  btn.disabled=true; btn.textContent='Obteniendo ubicación…';
  navigator.geolocation.getCurrentPosition(pos=>{
    const c=getFuelConfig();
    searchOrigin={lat:pos.coords.latitude,lon:pos.coords.longitude};
    saveFuelConfig({mode:'location',radius:c.radius,lat:pos.coords.latitude,lon:pos.coords.longitude});
    btn.disabled=false; btn.textContent='📍 Usar mi ubicación actual'; $('fuelSettingsDialog').close(); loadData(true);
  },()=>{
    btn.disabled=false; btn.textContent='📍 Usar mi ubicación actual'; $('stationSearchStatus').textContent='No hemos podido obtener tu ubicación. Revisa el permiso de localización del navegador.';
  },{enableHighAccuracy:false,timeout:10000,maximumAge:300000});
});

document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{ document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b===btn)); document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id===btn.dataset.tab)); }));
$('refreshBtn').addEventListener('click',()=>loadData(true));
window.addEventListener('beforeinstallprompt',(e)=>{e.preventDefault();deferredPrompt=e;});
$('installBtn').addEventListener('click',async()=>{ if(deferredPrompt){deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; return;} if(/iPhone|iPad|iPod/i.test(navigator.userAgent)) $('iosInstallDialog').showModal(); else alert('Abre el menú del navegador y selecciona “Instalar aplicación” o “Añadir a pantalla de inicio”.'); });
$('closeDialog').addEventListener('click',()=>$('iosInstallDialog').close());
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
updateSettingsSummary(); loadData(); setInterval(()=>loadData(false),5*60*1000);
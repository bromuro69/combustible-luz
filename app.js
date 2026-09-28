const $ = (id) => document.getElementById(id);
let deferredPrompt = null;

const PRODUCT_NAMES = { g95: 'Gasolina 95', g98: 'Gasolina 98', diesel: 'Gasóleo A' };

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

  $('top3').innerHTML = sorted.slice(0,3).map((x,i)=>`<div class="top-item"><span>${['1ª','2ª','3ª'][i]} mejor</span><strong>${hourLabel(x.hora)}</strong><span>${fmtPrice(x.pvpc)} €/kWh</span></div>`).join('');
  $('hourlyList').innerHTML = hours.map(x => `<div class="price-row ${x.hora===nowHour?'current':''}"><span class="time">${hourLabel(x.hora)}</span><span>${rankEmoji(rankMap.get(x.hora))}</span><span class="price">${fmtPrice(x.pvpc)} €/kWh</span></div>`).join('');
  $('rankingList').innerHTML = sorted.map((x,rank)=>`<div class="price-row ${x.hora===nowHour?'current':''}"><span class="time">${hourLabel(x.hora)}</span><span><span class="rank-dot ${rankClass(rank)}" style="display:inline-block;margin-right:8px"></span>${rank<8?'Barata':rank<16?'Media':'Cara'}</span><span class="price">${fmtPrice(x.pvpc)} €/kWh</span></div>`).join('');
  const vals = hours.map(x=>Number(x.pvpc)); const min=Math.min(...vals), max=Math.max(...vals), span=Math.max(max-min,.001);
  $('hourlyChart').innerHTML = hours.map(x=>{ const rank=rankMap.get(x.hora); const pct=18+((Number(x.pvpc)-min)/span)*82; return `<div class="chart-bar ${rankClass(rank)} ${x.hora===nowHour?'current':''}" style="height:${pct}%" title="${hourLabel(x.hora)} · ${fmtPrice(x.pvpc)} €/kWh"></div>`; }).join('');
}

function renderFuel(data) {
  const easy = data.easygas || {};
  $('easygasGrid').innerHTML = ['g95','g98','diesel'].map(key => {
    const price = easy[key]?.price;
    const priceHtml = hasNumber(price)
      ? `<strong>${fmtFuel(price)} <small>€/l</small></strong>`
      : `<strong class="no-price">Sin precio comunicado</strong>`;
    return `<div class="fuel-price"><span class="name">${PRODUCT_NAMES[key]}</span>${priceHtml}</div>`;
  }).join('');

  $('easygasUpdated').textContent = data.updatedLabel || 'Actualizado';

  $('cheapestFuel').innerHTML = ['g95','g98','diesel'].map(key => {
    const s = data.cheapest?.[key];
    if (!s) return `<div class="station-card"><div class="station-top"><span>${PRODUCT_NAMES[key]}</span><strong>—</strong></div><p>Sin dato disponible</p></div>`;

    const easyPrice = easy[key]?.price;
    const savingPerLitre = hasNumber(easyPrice) && hasNumber(s.price) ? Number(easyPrice) - Number(s.price) : 0;
    const savingHtml = savingPerLitre > 0.0005
      ? `<div class="saving"><span>Ahorras frente a EasyGas</span><strong>${fmtFuel(savingPerLitre)} €/l · ${fmtMoney(savingPerLitre * 50)} € en 50 L</strong></div>`
      : '';

    return `<div class="station-card"><div class="station-top"><span>${PRODUCT_NAMES[key]}</span><strong>${fmtFuel(s.price)} €/l</strong></div><h3>${escapeHtml(s.brand||'Estación de servicio')}</h3><p>${escapeHtml(s.address||'Gijón')}</p>${savingHtml}</div>`;
  }).join('');
}

function renderGas(data) {
  const tariffs = Array.isArray(data.tariffs) ? data.tariffs : [];
  $('gasPeriod').textContent = data.periodLabel || 'Tarifa vigente';
  $('gasGrid').innerHTML = tariffs.map(t => `
    <article class="gas-card">
      <div class="gas-card-head">
        <div>
          <span class="card-label">${escapeHtml(t.id)}</span>
          <h3>${escapeHtml(t.consumption)}</h3>
        </div>
      </div>
      <div class="gas-main-price">
        <strong>${fmtGasVariable(t.variablePerKwh)}</strong>
        <span>€/kWh</span>
      </div>
      <p class="gas-caption">Término variable</p>
      <div class="gas-fixed"><span>Fijo mensual</span><strong>${fmtMoney(t.fixedMonthly)} €/mes</strong></div>
    </article>`).join('');

  const notice = $('gasNotice');
  if (data.validUntil) {
    const expires = new Date(`${data.validUntil}T23:59:59+02:00`).getTime();
    const expired = Number.isFinite(expires) && Date.now() > expires;
    notice.classList.toggle('hidden', !expired);
    if (expired) notice.textContent = 'Esta TUR ha terminado su periodo de vigencia. Estamos pendientes de cargar la siguiente tarifa oficial publicada en el BOE.';
  } else {
    notice.classList.add('hidden');
  }

  const sourceLink = $('gasSourceLink');
  if (data.sourceUrl) {
    sourceLink.href = data.sourceUrl;
    sourceLink.classList.remove('hidden');
  } else {
    sourceLink.classList.add('hidden');
  }
}

async function loadData(force=false) {
  $('status').classList.add('hidden'); $('refreshBtn').classList.add('loading'); $('refreshBtn').disabled=true;
  try {
    const res = await fetch(`/api/dashboard${force?`?t=${Date.now()}`:''}`, { cache: force ? 'no-store' : 'default' });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const payload = await res.json();
    if (!payload.electricity?.hours?.length) throw new Error('No se recibieron precios de electricidad.');
    renderFuel(payload.fuel||{}); renderElectricity(payload.electricity); renderGas(payload.gas||{});
    const ts=new Date(payload.generatedAt||Date.now()); $('lastUpdated').textContent=`Actualizado ${ts.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`;
  } catch(err) { $('status').textContent=`No se pudieron actualizar los datos: ${err.message}`; $('status').classList.remove('hidden'); }
  finally { $('refreshBtn').classList.remove('loading'); $('refreshBtn').disabled=false; }
}

document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{ document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b===btn)); document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id===btn.dataset.tab)); }));
$('refreshBtn').addEventListener('click',()=>loadData(true));
window.addEventListener('beforeinstallprompt',(e)=>{e.preventDefault();deferredPrompt=e;});
$('installBtn').addEventListener('click',async()=>{ if(deferredPrompt){deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; return;} if(/iPhone|iPad|iPod/i.test(navigator.userAgent)) $('iosInstallDialog').showModal(); else alert('Abre el menú del navegador y selecciona “Instalar aplicación” o “Añadir a pantalla de inicio”.'); });
$('closeDialog').addEventListener('click',()=>$('iosInstallDialog').close());
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
loadData(); setInterval(()=>loadData(false),5*60*1000);

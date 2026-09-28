const PRECI_URL = 'https://preciluz.com/datos/precio-hoy.json';
const MITECO_BASES = [
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes',
  'https://energia.serviciosmin.gob.es/ServiciosRestCarburantes/PreciosCarburantes'
];
const PRODUCTS = { g95: '1', g98: '3', diesel: '4' };
const ASTURIAS_ID = '03';
const EASYGAS_ID = '886';

const GAS_TUR = {
  periodLabel: 'Vigente · 1 jul–30 sep 2026',
  validFrom: '2026-07-01',
  validUntil: '2026-09-30',
  source: 'BOE-A-2026-14233',
  sourceUrl: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-14233',
  tariffs: [
    { id: 'TUR.1', consumption: '≤ 5.000 kWh/año', fixedMonthly: 3.93, variablePerKwh: 0.04329798 },
    { id: 'TUR.2', consumption: '> 5.000 y ≤ 15.000 kWh/año', fixedMonthly: 8.11, variablePerKwh: 0.04119908 },
    { id: 'TUR.3', consumption: '> 15.000 y ≤ 50.000 kWh/año', fixedMonthly: 18.82, variablePerKwh: 0.03775844 }
  ]
};

function normalizeText(v='') { return String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase(); }
function parseNumber(v) { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.').replace(/\s/g,'')); return Number.isFinite(n) ? n : null; }
function getField(row, names) { for (const n of names) if (row?.[n] !== undefined && row?.[n] !== null && row?.[n] !== '') return row[n]; return ''; }
function stationFromRow(row) { return { id:String(getField(row,['IDEESS','IdEESS','id'])||''), brand:String(getField(row,['Rótulo','Rotulo','rotulo','Marca'])||''), address:String(getField(row,['Dirección','Direccion','direccion'])||''), municipality:String(getField(row,['Municipio','municipio'])||''), locality:String(getField(row,['Localidad','localidad'])||''), price:parseNumber(getField(row,['PrecioProducto','Precio producto','precio','Precio'])) }; }
function listRows(json) { if (Array.isArray(json)) return json; return json?.ListaEESSPrecio || json?.listaEESSPrecio || json?.estaciones || json?.results || []; }
async function fetchJson(url, timeout=8000) { const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout); try { const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Energias-PWA/1.0'},signal:ctrl.signal}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return await r.json(); } finally { clearTimeout(timer); } }
async function fetchFuelProduct(productId) { let lastError; for(const base of MITECO_BASES){ try { return await fetchJson(`${base}/EstacionesTerrestres/FiltroCCAAProducto/${ASTURIAS_ID}/${productId}`); } catch(e){ lastError=e; } } throw lastError || new Error('MITECO no disponible'); }
function pickFuel(json) { const stations=listRows(json).map(stationFromRow).filter(s=>s.price!==null&&s.price>0); const easygas=stations.find(s=>s.id===EASYGAS_ID)||stations.find(s=>normalizeText(s.brand).includes('EASYGAS')&&normalizeText(s.municipality).includes('GIJON'))||null; const gijon=stations.filter(s=>normalizeText(s.municipality).includes('GIJON')||normalizeText(s.locality).includes('GIJON')); const cheapest=[...gijon].sort((a,b)=>a.price-b.price)[0]||null; return {easygas,cheapest}; }
function fuelDateLabel(jsons) { for(const j of jsons){ const raw=j?.Fecha||j?.fecha; if(raw) return String(raw); } return 'Actualizado'; }

module.exports = async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=600');
  try {
    const [electricity,g95j,g98j,dieselj]=await Promise.all([fetchJson(PRECI_URL,6500),fetchFuelProduct(PRODUCTS.g95),fetchFuelProduct(PRODUCTS.g98),fetchFuelProduct(PRODUCTS.diesel)]);
    const g95=pickFuel(g95j), g98=pickFuel(g98j), diesel=pickFuel(dieselj);
    res.status(200).json({
      generatedAt:new Date().toISOString(),
      electricity:{date:electricity.fecha,updatedAt:electricity.actualizado,unit:electricity.unidad||'€/kWh',summary:electricity.resumen||{},hours:Array.isArray(electricity.horas)?electricity.horas.map(h=>({hora:Number(h.hora),pvpc:Number(h.pvpc),tramo:h.tramo})):[]},
      fuel:{updatedLabel:fuelDateLabel([g95j,g98j,dieselj]),easygas:{g95:g95.easygas,g98:g98.easygas,diesel:diesel.easygas},cheapest:{g95:g95.cheapest,g98:g98.cheapest,diesel:diesel.cheapest}},
      gas:GAS_TUR
    });
  } catch(err){ console.error(err); res.status(502).json({error:'No se pudieron obtener los datos',detail:err?.message||String(err)}); }
};

module.exports._test = { normalizeText, parseNumber, stationFromRow, listRows, pickFuel, GAS_TUR };

const PRECI_URL = 'https://preciluz.com/datos/precio-hoy.json';
const MITECO_BASES = [
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes',
  'https://energia.serviciosmin.gob.es/ServiciosRestCarburantes/PreciosCarburantes'
];
const PRODUCTS = { g95: '1', g98: '3', diesel: '4' };
const EASYGAS_ID = '886';

const GAS_TUR = {
  periodLabel: 'Vigente · 1 oct–31 dic 2026',
  validFrom: '2026-10-01',
  validUntil: '2026-12-31',
  source: 'BOE-A-2026-20389',
  sourceUrl: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-20389',
  tariffs: [
    { id: 'TUR.1', consumption: '≤ 5.000 kWh/año', fixedMonthly: 3.83, variablePerKwh: 0.05252590 },
    { id: 'TUR.2', consumption: '> 5.000 y ≤ 15.000 kWh/año', fixedMonthly: 8.17, variablePerKwh: 0.05042762 },
    { id: 'TUR.3', consumption: '> 15.000 y ≤ 50.000 kWh/año', fixedMonthly: 19.32, variablePerKwh: 0.04698799 }
  ]
};

function normalizeText(v='') { return String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase(); }
function parseNumber(v) { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.').replace(/\s/g,'')); return Number.isFinite(n) ? n : null; }
function getField(row, names) { for (const n of names) if (row?.[n] !== undefined && row?.[n] !== null && row?.[n] !== '') return row[n]; return ''; }
function stationFromRow(row) {
  return {
    id:String(getField(row,['IDEESS','IdEESS','id'])||''),
    brand:String(getField(row,['Rótulo','Rotulo','rotulo','Marca'])||''),
    address:String(getField(row,['Dirección','Direccion','direccion'])||''),
    postalCode:String(getField(row,['C.P.','CP','Codigo Postal','Código Postal'])||''),
    municipality:String(getField(row,['Municipio','municipio'])||''),
    locality:String(getField(row,['Localidad','localidad'])||''),
    province:String(getField(row,['Provincia','provincia'])||''),
    lat:parseNumber(getField(row,['Latitud','latitud','Latitude'])),
    lon:parseNumber(getField(row,['Longitud (WGS84)','Longitud_x0020__x0028_WGS84_x0029_','Longitud','longitud','Longitude'])),
    price:parseNumber(getField(row,['PrecioProducto','Precio producto','precio','Precio']))
  };
}
function listRows(json) { if (Array.isArray(json)) return json; return json?.ListaEESSPrecio || json?.listaEESSPrecio || json?.estaciones || json?.results || []; }
async function fetchJson(url, timeout=10000) {
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout);
  try {
    const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Energias-PWA/1.1'},signal:ctrl.signal});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function fetchFuelProduct(productId) {
  let lastError;
  for(const base of MITECO_BASES){
    try { return await fetchJson(`${base}/EstacionesTerrestres/FiltroProducto/${productId}`); }
    catch(e){ lastError=e; }
  }
  throw lastError || new Error('MITECO no disponible');
}
function fuelDateLabel(jsons) { for(const j of jsons){ const raw=j?.Fecha||j?.fecha; if(raw) return String(raw); } return 'Actualizado'; }
function toRad(v){ return Number(v) * Math.PI / 180; }
function distanceKm(lat1,lon1,lat2,lon2){
  if (![lat1,lon1,lat2,lon2].every(v => Number.isFinite(Number(v)))) return null;
  const R=6371;
  const dLat=toRad(Number(lat2)-Number(lat1));
  const dLon=toRad(Number(lon2)-Number(lon1));
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function cleanStation(s){
  if (!s) return null;
  return {id:s.id,brand:s.brand,address:s.address,postalCode:s.postalCode,municipality:s.municipality,locality:s.locality,province:s.province,lat:s.lat,lon:s.lon,price:s.price,distanceKm:s.distanceKm};
}
function findStation(lists, id){
  if (!id) return null;
  for (const list of lists) {
    const found=list.find(s=>s.id===String(id));
    if (found) return found;
  }
  return null;
}
function cheapestWithin(stations,lat,lon,radiusKm){
  const nearby=stations
    .filter(s=>s.price!==null&&s.price>0&&s.lat!==null&&s.lon!==null)
    .map(s=>({...s,distanceKm:distanceKm(lat,lon,s.lat,s.lon)}))
    .filter(s=>s.distanceKm!==null&&s.distanceKm<=radiusKm)
    .sort((a,b)=>a.price-b.price || a.distanceKm-b.distanceKm);
  return nearby[0] ? cleanStation({...nearby[0],distanceKm:Math.round(nearby[0].distanceKm*10)/10}) : null;
}
function priceAtStation(stations,id){
  const s=stations.find(x=>x.id===String(id));
  return s ? cleanStation(s) : null;
}

// Se conserva para los tests históricos del proyecto.
function pickFuel(json) {
  const stations=listRows(json).map(stationFromRow).filter(s=>s.price!==null&&s.price>0);
  const easygas=stations.find(s=>s.id===EASYGAS_ID)||stations.find(s=>normalizeText(s.brand).includes('EASYGAS')&&normalizeText(s.municipality).includes('GIJON'))||null;
  const gijon=stations.filter(s=>normalizeText(s.municipality).includes('GIJON')||normalizeText(s.locality).includes('GIJON'));
  const cheapest=[...gijon].sort((a,b)=>a.price-b.price)[0]||null;
  return {easygas,cheapest};
}

module.exports = async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=600');
  try {
    const radiusKm=[5,10,15,25].includes(Number(req.query?.radius)) ? Number(req.query.radius) : 10;
    const mode=req.query?.mode==='location' ? 'location' : 'station';
    const stationId=String(req.query?.stationId || EASYGAS_ID);
    const requestedLat=parseNumber(req.query?.lat);
    const requestedLon=parseNumber(req.query?.lon);

    const [electricity,g95j,g98j,dieselj]=await Promise.all([
      fetchJson(PRECI_URL,6500),
      fetchFuelProduct(PRODUCTS.g95),
      fetchFuelProduct(PRODUCTS.g98),
      fetchFuelProduct(PRODUCTS.diesel)
    ]);

    const lists={
      g95:listRows(g95j).map(stationFromRow),
      g98:listRows(g98j).map(stationFromRow),
      diesel:listRows(dieselj).map(stationFromRow)
    };
    const allLists=[lists.g95,lists.g98,lists.diesel];
    const referenceStation=mode==='station' ? findStation(allLists,stationId) : null;
    const centerLat=mode==='location' ? requestedLat : referenceStation?.lat;
    const centerLon=mode==='location' ? requestedLon : referenceStation?.lon;
    if (!Number.isFinite(Number(centerLat)) || !Number.isFinite(Number(centerLon))) throw new Error('No se pudo determinar el punto de referencia para combustible');

    const referencePrices=mode==='station' ? {
      g95:priceAtStation(lists.g95,stationId),
      g98:priceAtStation(lists.g98,stationId),
      diesel:priceAtStation(lists.diesel,stationId)
    } : {g95:null,g98:null,diesel:null};
    const cheapest={
      g95:cheapestWithin(lists.g95,centerLat,centerLon,radiusKm),
      g98:cheapestWithin(lists.g98,centerLat,centerLon,radiusKm),
      diesel:cheapestWithin(lists.diesel,centerLat,centerLon,radiusKm)
    };

    res.status(200).json({
      generatedAt:new Date().toISOString(),
      electricity:{date:electricity.fecha,updatedAt:electricity.actualizado,unit:electricity.unidad||'€/kWh',summary:electricity.resumen||{},hours:Array.isArray(electricity.horas)?electricity.horas.map(h=>({hora:Number(h.hora),pvpc:Number(h.pvpc),tramo:h.tramo})):[]},
      fuel:{
        mode,
        radiusKm,
        updatedLabel:fuelDateLabel([g95j,g98j,dieselj]),
        reference:mode==='station' ? cleanStation(referenceStation) : {brand:'Tu ubicación actual',address:'Comparación desde este punto',lat:centerLat,lon:centerLon},
        referencePrices,
        cheapest
      },
      gas:GAS_TUR
    });
  } catch(err){ console.error(err); res.status(502).json({error:'No se pudieron obtener los datos',detail:err?.message||String(err)}); }
};

module.exports._test = { normalizeText, parseNumber, stationFromRow, listRows, pickFuel, distanceKm, GAS_TUR };

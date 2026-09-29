const MITECO_BASES = [
  'https://energia.serviciosmin.gob.es/ServiciosRestCarburantes/PreciosCarburantes',
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes'
];
const SEARCH_PRODUCTS = ['1','4']; // Gasolina 95 + Gasóleo A: cubren la práctica totalidad de estaciones terrestres

function normalizeText(v='') {
  return String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
}
function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.').replace(/\s/g,''));
  return Number.isFinite(n) ? n : null;
}
function getField(row, names) {
  for (const n of names) if (row?.[n] !== undefined && row?.[n] !== null && row?.[n] !== '') return row[n];
  return '';
}
function listRows(json) {
  if (Array.isArray(json)) return json;
  return json?.ListaEESSPrecio || json?.listaEESSPrecio || json?.estaciones || json?.results || [];
}
function stationFromRow(row) {
  return {
    id: String(getField(row,['IDEESS','IdEESS','id']) || ''),
    brand: String(getField(row,['Rótulo','Rotulo','rotulo','Marca']) || ''),
    address: String(getField(row,['Dirección','Direccion','direccion']) || ''),
    postalCode: String(getField(row,['C.P.','CP','Codigo Postal','Código Postal']) || ''),
    municipality: String(getField(row,['Municipio','municipio']) || ''),
    locality: String(getField(row,['Localidad','localidad']) || ''),
    province: String(getField(row,['Provincia','provincia']) || ''),
    lat: parseNumber(getField(row,['Latitud','latitud','Latitude'])),
    lon: parseNumber(getField(row,['Longitud (WGS84)','Longitud_x0020__x0028_WGS84_x0029_','Longitud','longitud','Longitude']))
  };
}
async function fetchJson(url, timeout=15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers:{Accept:'application/json','User-Agent':'Energias-PWA/1.2'}, signal:ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function fetchProductStations(productId) {
  let lastError;
  for (const base of MITECO_BASES) {
    try { return await fetchJson(`${base}/EstacionesTerrestres/FiltroProducto/${productId}`); }
    catch (e) { lastError = e; }
  }
  throw lastError || new Error('MITECO no disponible');
}
function scoreStation(s, q) {
  const fields = [s.brand,s.address,s.locality,s.municipality,s.province,s.postalCode].map(normalizeText);
  let score = 0;
  for (const value of fields) {
    if (!value) continue;
    if (value === q) score += 100;
    else if (value.startsWith(q)) score += 45;
    else if (value.includes(q)) score += 15;
  }
  return score;
}

module.exports = async function handler(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate=3600');
  try {
    const q = normalizeText(req.query?.q || '');
    if (q.length < 2) return res.status(200).json({stations:[]});

    // Evitamos descargar el listado nacional completo (~20 MB), que hacía fallar la búsqueda en Vercel.
    const payloads = await Promise.all(SEARCH_PRODUCTS.map(fetchProductStations));
    const unique = new Map();
    for (const payload of payloads) {
      for (const row of listRows(payload)) {
        const station = stationFromRow(row);
        if (!station.id || station.lat === null || station.lon === null) continue;
        if (!unique.has(station.id)) unique.set(station.id, station);
      }
    }

    const stations = [...unique.values()]
      .map(s => ({...s, score:scoreStation(s,q)}))
      .filter(s => s.score > 0)
      .sort((a,b) => b.score-a.score || a.brand.localeCompare(b.brand,'es'))
      .slice(0,30)
      .map(({score,...s}) => s);

    res.status(200).json({stations});
  } catch(err) {
    console.error(err);
    res.status(502).json({error:'No se pudieron buscar estaciones',detail:err?.message||String(err)});
  }
};

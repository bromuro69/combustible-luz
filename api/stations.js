const MITECO_BASES = [
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes',
  'https://energia.serviciosmin.gob.es/ServiciosRestCarburantes/PreciosCarburantes'
];

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
async function fetchJson(url, timeout=9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers:{Accept:'application/json','User-Agent':'Energias-PWA/1.0'}, signal:ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function fetchAllStations() {
  let lastError;
  for (const base of MITECO_BASES) {
    try { return await fetchJson(`${base}/EstacionesTerrestres/`); }
    catch (e) { lastError = e; }
  }
  throw lastError || new Error('MITECO no disponible');
}
function scoreStation(s, q) {
  const parts = [s.brand,s.address,s.locality,s.municipality,s.province,s.postalCode].map(normalizeText);
  let score = 0;
  for (const p of parts) {
    if (p === q) score += 100;
    else if (p.startsWith(q)) score += 40;
    else if (p.includes(q)) score += 12;
  }
  return score;
}

module.exports = async function handler(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate=3600');
  try {
    const q = normalizeText(req.query?.q || '');
    if (q.length < 2) return res.status(200).json({stations:[]});
    const json = await fetchAllStations();
    const stations = listRows(json)
      .map(stationFromRow)
      .filter(s => s.id && s.lat !== null && s.lon !== null)
      .map(s => ({...s, score:scoreStation(s,q)}))
      .filter(s => s.score > 0)
      .sort((a,b) => b.score-a.score || a.brand.localeCompare(b.brand,'es'))
      .slice(0,24)
      .map(({score,...s}) => s);
    res.status(200).json({stations});
  } catch(err) {
    console.error(err);
    res.status(502).json({error:'No se pudieron buscar estaciones',detail:err?.message||String(err)});
  }
};

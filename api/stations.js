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
    const r = await fetch(url, { headers:{Accept:'application/json','User-Agent':'Energias-PWA/1.3'}, signal:ctrl.signal });
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
function queryTokens(q) {
  return normalizeText(q).split(/\s+/).filter(Boolean);
}
function searchableText(s) {
  return normalizeText([s.brand,s.address,s.locality,s.municipality,s.province,s.postalCode].filter(Boolean).join(' '));
}
function matchesTokens(s, tokens) {
  const haystack = searchableText(s);
  return tokens.every(token => haystack.includes(token));
}
function scoreStation(s, tokens) {
  const fields = [s.brand,s.address,s.locality,s.municipality,s.province,s.postalCode].map(normalizeText);
  let score = 0;
  for (const token of tokens) {
    for (const value of fields) {
      if (!value) continue;
      if (value === token) score += 100;
      else if (value.startsWith(token)) score += 45;
      else if (value.includes(token)) score += 15;
    }
  }
  return score;
}
function toRad(v){ return Number(v) * Math.PI / 180; }
function distanceKm(lat1,lon1,lat2,lon2){
  if (![lat1,lon1,lat2,lon2].every(v => Number.isFinite(Number(v)))) return null;
  const R=6371;
  const dLat=toRad(Number(lat2)-Number(lat1));
  const dLon=toRad(Number(lon2)-Number(lon1));
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

module.exports = async function handler(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=1800, stale-while-revalidate=3600');
  try {
    const rawQ = String(req.query?.q || '').trim();
    const tokens = queryTokens(rawQ);
    if (normalizeText(rawQ).length < 2 || !tokens.length) return res.status(200).json({stations:[]});

    const originLat = parseNumber(req.query?.lat);
    const originLon = parseNumber(req.query?.lon);
    const hasOrigin = Number.isFinite(originLat) && Number.isFinite(originLon);

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
      .filter(s => matchesTokens(s,tokens))
      .map(s => {
        const distance = hasOrigin ? distanceKm(originLat,originLon,s.lat,s.lon) : null;
        return {...s, score:scoreStation(s,tokens), distanceKm:distance === null ? null : Math.round(distance*10)/10};
      })
      .sort((a,b) => {
        if (hasOrigin) {
          const ad = Number.isFinite(a.distanceKm) ? a.distanceKm : Number.POSITIVE_INFINITY;
          const bd = Number.isFinite(b.distanceKm) ? b.distanceKm : Number.POSITIVE_INFINITY;
          if (ad !== bd) return ad-bd;
        }
        return b.score-a.score || a.brand.localeCompare(b.brand,'es');
      })
      .slice(0,30)
      .map(({score,...s}) => s);

    res.status(200).json({stations, sortedByDistance:hasOrigin});
  } catch(err) {
    console.error(err);
    res.status(502).json({error:'No se pudieron buscar estaciones',detail:err?.message||String(err)});
  }
};
const $ = (id) => document.getElementById(id);
let albums = [];
let deferredPrompt = null;
let searchTimer = null;

function normalize(value='') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu,' ')
    .trim()
    .replace(/\s+/g,' ');
}
function escapeHtml(value='') {
  return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]));
}
function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {name:'PBKDF2', salt, iterations, hash:'SHA-256'},
    material,
    {name:'AES-GCM', length:256},
    false,
    ['decrypt']
  );
}
async function decryptPayload(password) {
  const response = await fetch('./data/manifest.json', {cache:'no-store'});
  if (!response.ok) throw new Error('No se pudo cargar el archivo cifrado.');
  const blob = await response.json();
  const pieces = await Promise.all((blob.parts || []).map(async name => {
    const r = await fetch(`./data/${name}`, {cache:'no-store'});
    if (!r.ok) throw new Error('No se pudo cargar una parte del archivo cifrado.');
    return (await r.text()).trim();
  }));
  const encrypted = pieces.join('');
  const key = await deriveKey(password, b64ToBytes(blob.salt), Number(blob.iterations));
  const clear = await crypto.subtle.decrypt(
    {name:'AES-GCM', iv:b64ToBytes(blob.iv), additionalData:new TextEncoder().encode(blob.aad || 'albumes-v2')},
    key,
    b64ToBytes(encrypted)
  );
  let bytes = new Uint8Array(clear);
  if (blob.compression === 'gzip') {
    if (typeof DecompressionStream === 'undefined') throw new Error('Este navegador no admite la descompresión segura necesaria.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function scoreAlbum(album, query) {
  const name = album._n;
  const tokens = query.split(' ').filter(Boolean);
  if (!tokens.every(t => name.includes(t))) return -1;
  let score = 0;
  if (name === query) score += 10000;
  if (name.startsWith(query)) score += 5000;
  if (name.includes(query)) score += 2500;
  for (const token of tokens) {
    if (name.startsWith(token)) score += 500;
    const words = name.split(' ');
    if (words.some(w => w.startsWith(token))) score += 250;
    score += Math.max(0, 100 - name.indexOf(token));
  }
  score -= Math.min(name.length, 120) * .1;
  return score;
}
function renderSearch() {
  const q = normalize($('searchInput').value);
  $('clearSearch').classList.toggle('hidden', !$('searchInput').value);
  if (!q) {
    $('resultsCard').classList.add('hidden');
    $('emptyState').classList.remove('hidden');
    $('searchMeta').textContent = 'Escribe el nombre o parte del nombre del álbum.';
    return;
  }
  const matches = albums
    .map(a => ({a, score:scoreAlbum(a,q)}))
    .filter(x => x.score >= 0)
    .sort((x,y) => y.score-x.score || x.a.name.localeCompare(y.a.name,'es',{sensitivity:'base'}));
  const max = 120;
  const shown = matches.slice(0,max);
  $('emptyState').classList.add('hidden');
  $('resultsCard').classList.remove('hidden');
  $('searchMeta').textContent = matches.length
    ? `${matches.length.toLocaleString('es-ES')} resultado${matches.length===1?'':'s'}${matches.length>max?` · mostrando ${max}`:''}`
    : 'Sin resultados';
  $('resultsList').innerHTML = shown.length ? shown.map(({a}) => `
    <a class="result-row" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">
      <span class="result-main">
        <span class="result-name">${escapeHtml(a.name)}</span>
        <span class="result-sub">Google Fotos</span>
      </span>
      <span class="open-pill">Abrir ↗</span>
    </a>`).join('') : `
    <div class="empty-state" style="min-height:180px">
      <div class="empty-symbol">⌕</div>
      <strong>No encuentro ese álbum</strong>
      <span>Prueba con menos palabras o con otra parte del nombre.</span>
    </div>`;
}
function lockApp() {
  albums = [];
  $('searchInput').value = '';
  $('resultsList').innerHTML = '';
  $('appView').classList.add('hidden');
  $('lockedView').classList.remove('hidden');
  $('passwordInput').value = '';
  $('unlockStatus').textContent = '';
  setTimeout(() => $('passwordInput').focus(), 50);
}
async function unlock(password) {
  const btn = $('unlockBtn');
  btn.disabled = true;
  btn.textContent = 'Descifrando…';
  $('unlockStatus').textContent = '';
  try {
    const payload = await decryptPayload(password);
    if (!Array.isArray(payload.albums)) throw new Error('Datos no válidos');
    albums = payload.albums.map(a => ({...a, _n:normalize(a.name)}));
    $('albumCount').textContent = `${albums.length.toLocaleString('es-ES')} álbumes disponibles`;
    $('lockedView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('searchInput').focus();
    renderSearch();
  } catch (error) {
    $('unlockStatus').textContent = 'Clave incorrecta. Compruébala y vuelve a intentarlo.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Desbloquear';
  }
}

$('unlockForm').addEventListener('submit', e => {
  e.preventDefault();
  const password = $('passwordInput').value;
  if (!password) {
    $('unlockStatus').textContent = 'Introduce la clave de acceso.';
    return;
  }
  unlock(password);
});
$('togglePassword').addEventListener('click', () => {
  const input = $('passwordInput');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('togglePassword').textContent = input.type === 'password' ? '◉' : '●';
});
$('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderSearch, 70);
});
$('clearSearch').addEventListener('click', () => {
  $('searchInput').value = '';
  renderSearch();
  $('searchInput').focus();
});
$('lockBtn').addEventListener('click', lockApp);

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
});
$('installBtn').addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    return;
  }
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) $('iosInstallDialog').showModal();
  else alert('Abre el menú del navegador y selecciona “Instalar aplicación” o “Añadir a pantalla de inicio”.');
});
$('closeDialog').addEventListener('click', () => $('iosInstallDialog').close());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js', {scope:'./'}).catch(() => {}));
}

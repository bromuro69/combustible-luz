(() => {
  const el = document.getElementById('placeName');
  if (!el || !navigator.geolocation) return;

  let resolving = false;
  let lastCoords = null;

  async function reverseName(lat, lon) {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('zoom', '14');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('accept-language', 'es');
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('reverse geocoding');
    const data = await r.json();
    const a = data.address || {};
    return a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb || a.county || '';
  }

  function resolveCurrentName() {
    if (resolving) return;
    resolving = true;
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        lastCoords = { lat, lon };
        const name = await reverseName(lat, lon);
        if (name && (el.textContent === 'Mi ubicación' || el.textContent === 'Localizando…')) {
          el.textContent = name;
          if (window.currentPlace && !window.currentPlace.manual) window.currentPlace.name = name;
        }
      } catch (_) {
        // Conserva el comportamiento actual si no se puede resolver el nombre.
      } finally {
        resolving = false;
      }
    }, () => { resolving = false; }, { enableHighAccuracy: false, timeout: 7000, maximumAge: 10 * 60 * 1000 });
  }

  const observer = new MutationObserver(() => {
    if (el.textContent === 'Mi ubicación') resolveCurrentName();
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });

  if (el.textContent === 'Mi ubicación' || el.textContent === 'Localizando…') resolveCurrentName();
})();

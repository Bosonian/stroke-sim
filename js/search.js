// Place search for placing the ambulance: the example places first (instant, also offline), then
// Photon by komoot (OpenStreetMap data, made for search as you type), limited to Germany.

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Example places matching the text (all of them for an empty box), without case or accents. */
export function matchPresets(q, places) {
  const f = fold(q.trim());
  return places.filter((p) => !f || fold(p.name).includes(f))
    .map((p) => ({ label: p.name, sub: '', lon: p.lon, lat: p.lat, preset: true }));
}

export function photonUrl(q, lang, cfg) {
  return `${cfg.url}/api/?q=${encodeURIComponent(q)}&lang=${lang === 'de' ? 'de' : 'en'}&limit=${cfg.limit}&bbox=${cfg.bbox.join(',')}`;
}

/** Photon GeoJSON -> [{ label, sub, lon, lat }]: places in Germany, named, without duplicates. */
export function parsePhoton(json) {
  const out = [];
  const seen = new Set();
  for (const f of (json && json.features) || []) {
    const p = f.properties || {};
    const c = f.geometry && f.geometry.coordinates;
    if (p.countrycode !== 'DE' || !c) continue;
    const street = p.street ? `${p.street}${p.housenumber ? ` ${p.housenumber}` : ''}` : '';
    const label = p.name || street || p.city;
    if (!label) continue;
    const town = `${p.postcode || ''} ${p.city || p.district || ''}`.trim();
    const sub = [p.name ? street : '', town, p.state].filter((x) => x && x !== label).join(', ');
    const key = `${label}|${sub}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, sub, lon: c[0], lat: c[1] });
  }
  return out;
}

/** { local, remote, failed }: example places at once; online results from cfg.minChars letters on.
 *  A failed search keeps the examples (failed = true); an aborted one (a newer search started) throws. */
export async function searchPlaces(q, { fetchFn, lang, places, cfg, signal }) {
  const local = matchPresets(q, places);
  if (q.trim().length < cfg.minChars) return { local, remote: [], failed: false };
  try {
    const res = await fetchFn(photonUrl(q.trim(), lang, cfg), { signal });
    if (!res.ok) throw new Error(`search ${res.status}`);
    return { local, remote: parsePhoton(await res.json()), failed: false };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return { local, remote: [], failed: true };
  }
}

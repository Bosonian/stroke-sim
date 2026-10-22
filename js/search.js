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

export function reverseUrl(lon, lat, lang, cfg) {
  return `${cfg.url}/reverse?lon=${lon.toFixed(5)}&lat=${lat.toFixed(5)}&lang=${lang === 'de' ? 'de' : 'en'}`;
}

/** Photon reverse result -> "Daun, Rheinland-Pfalz" (town, state); '' outside Germany or without a name. */
export function parseReverse(json) {
  const f = ((json && json.features) || [])[0];
  const p = (f && f.properties) || {};
  if (p.countrycode !== 'DE') return '';
  const town = p.city || p.locality || p.district || p.county || p.name;
  return [...new Set([town, p.state].filter(Boolean))].join(', '); // Berlin is town and state
}

/** Name of a point chosen on the map, or '' when the lookup fails (the caller then says "point on the map"). */
export async function reversePlace(lon, lat, { fetchFn, lang, cfg, signal }) {
  try {
    const res = await fetchFn(reverseUrl(lon, lat, lang, cfg), { signal });
    if (!res.ok) return '';
    return parseReverse(await res.json());
  } catch {
    return '';
  }
}

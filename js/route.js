// Live road routing for the simulator: OSRM public demo server (OpenStreetMap, car profile, no traffic).
// TOOL DATA, NOT STUDY RESULTS: the registered analysis uses its own OSRM run; this only draws roads and labels.
// Without an answer (offline, slow, rate-limited) the app falls back to the 1 km drive-time grid.

const R_EARTH_KM = 6371;
function km(aLon, aLat, bLon, bLat) {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.hypot(x, y) * R_EARTH_KM;
}

/** Indices of the n nearest hospitals of a kind ('su' | 'ns') by straight line, without excluded sites.
 *  The grid's choice (include) is always added, unless excluded, so a road-nearest site is never lost. */
export function candidates(hospitals, lon, lat, kind, n, excluded, include) {
  const ok = (h) => (kind === 'su' ? h.is_su : h.is_ns) && !excluded[h.id];
  const out = hospitals.filter(ok)
    .map((h) => [km(lon, lat, h.lon, h.lat), h.idx])
    .sort((a, b) => a[0] - b[0])
    .slice(0, n)
    .map(([, idx]) => idx);
  if (include != null && hospitals[include] && ok(hospitals[include]) && !out.includes(include)) out.push(include);
  return out;
}

/** Fastest reachable candidate from one table row (row[0] is the origin itself). Minutes at k = 1; km 1 decimal. */
export function pickFastest(durRow, distRow, idxs) {
  let best = null;
  idxs.forEach((idx, i) => {
    const d = durRow[i + 1];
    if (d == null) return;
    if (!best || d < best.sec) best = { idx, sec: d, m: distRow[i + 1] };
  });
  return best && { idx: best.idx, t: best.sec / 60, km: Math.round(best.m / 100) / 10 };
}

/** "7 min · 4.2 km": minutes scaled by the speed factor k (at least 1), km as driven. */
export function routeLabel(sec, meters, k) {
  const min = Math.max(1, Math.round((sec / 60) * k));
  const kmv = Math.round(meters / 100) / 10;
  return `${min} min · ${kmv < 10 ? kmv.toFixed(1) : Math.round(kmv)} km`;
}

async function getJson(fetchFn, url, timeoutMs) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, ctl ? { signal: ctl.signal } : undefined);
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.code === 'Ok' ? j : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Nearest stroke unit and neurosurgery site by road, with road geometry, or null on any failure.
 *  gridLook (may be null) supplies the grid's choices as extra candidates. */
export async function fetchLive(lon, lat, hospitals, gridLook, cfg, fetchFn = fetch) {
  const { url, candidates: n, timeoutMs } = cfg.routing;
  const ex = cfg.excludedSites || {};
  const su = candidates(hospitals, lon, lat, 'su', n, ex, gridLook?.su?.idx ?? null);
  const ns = candidates(hospitals, lon, lat, 'ns', n, ex, gridLook?.ns?.idx ?? null);
  if (!su.length || !ns.length) return null;
  const pt = (h) => `${h.lon.toFixed(6)},${h.lat.toFixed(6)}`;
  const origin = `${lon.toFixed(6)},${lat.toFixed(6)}`;
  try {
    const coords = [origin, ...su.map((i) => pt(hospitals[i])), ...ns.map((i) => pt(hospitals[i]))].join(';');
    const tb = await getJson(fetchFn, `${url}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`, timeoutMs);
    if (!tb) return null;
    const dur = tb.durations[0], dist = tb.distances[0];
    const bestSu = pickFastest(dur.slice(0, 1 + su.length), dist.slice(0, 1 + su.length), su);
    const bestNs = pickFastest([dur[0], ...dur.slice(1 + su.length)], [dist[0], ...dist.slice(1 + su.length)], ns);
    if (!bestSu || !bestNs) return null;
    const route = async (b) => {
      const j = await getJson(fetchFn, `${url}/route/v1/driving/${origin};${pt(hospitals[b.idx])}?overview=full&geometries=geojson`, timeoutMs);
      if (!j) return null;
      const r = j.routes[0];
      // shown minutes and km come from the drawn route, so card and map label agree; ranking used the table
      return { ...b, t: r.duration / 60, km: Math.round(r.distance / 100) / 10, sec: r.duration, m: r.distance, geom: r.geometry.coordinates };
    };
    const [rSu, rNs] = await Promise.all([route(bestSu), bestNs.idx === bestSu.idx ? null : route(bestNs)]);
    if (!rSu) return null;
    return { su: rSu, ns: rNs || (await route(bestNs)) || { ...bestNs, sec: bestNs.t * 60, m: bestNs.km * 1000, geom: null }, both: null };
  } catch {
    return null;
  }
}

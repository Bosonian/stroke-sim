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

/** One road route (k = 1) with per-segment durations, or null. a, b: [lon, lat]. */
async function getRoute(fetchFn, url, a, b, timeoutMs) {
  const pt = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
  const j = await getJson(fetchFn, `${url}/route/v1/driving/${pt(a)};${pt(b)}?overview=full&geometries=geojson&annotations=duration`, timeoutMs);
  if (!j) return null;
  const r = j.routes[0];
  const seg = r.legs && r.legs[0] && r.legs[0].annotation ? r.legs[0].annotation.duration : null;
  return { sec: r.duration, m: r.distance, geom: r.geometry.coordinates, segDur: seg };
}

/** Road route between two points (e.g. result point -> neurosurgery), or null on any failure. */
export async function fetchRoute(a, b, cfg, fetchFn = fetch) {
  try {
    return await getRoute(fetchFn, cfg.routing.url, a, b, cfg.routing.timeoutMs);
  } catch {
    return null;
  }
}

/** Nearest stroke unit and neurosurgery site by road, with road geometry, plus the transfer leg stroke unit ->
 *  neurosurgery (suNs; null when they are the same site or it failed); null on failure of the main request.
 *  gridLook (may be null) supplies the grid's choices as extra candidates. */
export async function fetchLive(lon, lat, hospitals, gridLook, cfg, fetchFn = fetch) {
  const { url, candidates: n, timeoutMs } = cfg.routing;
  const ex = cfg.excludedSites || {};
  const su = candidates(hospitals, lon, lat, 'su', n, ex, gridLook?.su?.idx ?? null);
  const ns = candidates(hospitals, lon, lat, 'ns', n, ex, gridLook?.ns?.idx ?? null);
  if (!su.length || !ns.length) return null;
  const at = (i) => [hospitals[i].lon, hospitals[i].lat];
  const origin = [lon, lat];
  try {
    const coords = [origin, ...su.map(at), ...ns.map(at)].map((c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`).join(';');
    const tb = await getJson(fetchFn, `${url}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`, timeoutMs);
    if (!tb) return null;
    const dur = tb.durations[0], dist = tb.distances[0];
    const bestSu = pickFastest(dur.slice(0, 1 + su.length), dist.slice(0, 1 + su.length), su);
    const bestNs = pickFastest([dur[0], ...dur.slice(1 + su.length)], [dist[0], ...dist.slice(1 + su.length)], ns);
    if (!bestSu || !bestNs) return null;
    // shown minutes and km come from the drawn route, so card and map label agree; ranking used the table
    const withRoute = (b, r) => r && { ...b, t: r.sec / 60, km: Math.round(r.m / 100) / 10, sec: r.sec, m: r.m, geom: r.geom, segDur: r.segDur };
    const same = bestNs.idx === bestSu.idx;
    const [rSu, rNs, suNs] = await Promise.all([
      getRoute(fetchFn, url, origin, at(bestSu.idx), timeoutMs),
      same ? null : getRoute(fetchFn, url, origin, at(bestNs.idx), timeoutMs),
      same ? null : getRoute(fetchFn, url, at(bestSu.idx), at(bestNs.idx), timeoutMs),
    ]);
    if (!rSu) return null;
    const suOut = withRoute(bestSu, rSu);
    return {
      su: suOut,
      ns: same ? suOut : withRoute(bestNs, rNs) || { ...bestNs, sec: bestNs.t * 60, m: bestNs.km * 1000, geom: null, segDur: null },
      both: null,
      suNs,
    };
  } catch {
    return null;
  }
}

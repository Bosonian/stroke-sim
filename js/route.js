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

/** "7 min · 4.2 km": minutes scaled by the speed factor k (at least 1), km as driven; `road` ("via B 11") appended. */
export function routeLabel(sec, meters, k, road = '') {
  const min = Math.max(1, Math.round((sec / 60) * k));
  const kmv = Math.round(meters / 100) / 10;
  return `${min} min · ${kmv < 10 ? kmv.toFixed(1) : Math.round(kmv)} km${road ? ` · ${road}` : ''}`;
}

/** Road number ("A 3", "B 11") driven longest on a route from second `fromSec` (k = 1) on; '' when none carries
 *  at least a fifth of the distance left. steps: [{ sec, m, ref }]. */
export function mainRoad(steps, fromSec = 0) {
  const by = new Map();
  let all = 0;
  let t = 0;
  for (const s of steps || []) {
    const t0 = t;
    t += s.sec;
    const part = s.sec > 0 ? Math.min(1, Math.max(0, (t - Math.max(t0, fromSec)) / s.sec)) : t0 >= fromSec ? 1 : 0;
    const m = s.m * part;
    all += m;
    const ref = (s.ref || '').split(';')[0].trim();
    if (ref && m > 0) by.set(ref, (by.get(ref) || 0) + m);
  }
  let best = '';
  for (const [ref, m] of by) if (!best || m > by.get(best)) best = ref;
  return best && by.get(best) >= all / 5 ? best : '';
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

/** One road route (k = 1) with per-segment durations, or null. a, b: [lon, lat].
 *  heading (degrees): leave a in that direction, snapped to a road within 25 m, so a re-route keeps driving forward
 *  on the same road until a real junction; the destination is unconstrained. */
async function getRoute(fetchFn, url, a, b, timeoutMs, heading = null) {
  const pt = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
  const dir = typeof heading === 'number' ? `&bearings=${Math.round(heading) % 360},30;&radiuses=25;unlimited` : '';
  const j = await getJson(fetchFn, `${url}/route/v1/driving/${pt(a)};${pt(b)}?overview=full&geometries=geojson&annotations=duration&steps=true${dir}`, timeoutMs);
  if (!j) return null;
  const r = j.routes[0];
  const leg = r.legs && r.legs[0];
  const seg = leg && leg.annotation ? leg.annotation.duration : null;
  const steps = leg && leg.steps ? leg.steps.map((s) => ({ sec: s.duration, m: s.distance, ref: s.ref || '' })) : null;
  return { sec: r.duration, m: r.distance, geom: r.geometry.coordinates, segDur: seg, steps };
}

/** Road route between two points (e.g. result point -> neurosurgery, in the ambulance's heading), or null. */
export async function fetchRoute(a, b, cfg, fetchFn = fetch, heading = null) {
  try {
    return await getRoute(fetchFn, cfg.routing.url, a, b, cfg.routing.timeoutMs, heading);
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
    const withRoute = (b, r) => r && { ...b, t: r.sec / 60, km: Math.round(r.m / 100) / 10, sec: r.sec, m: r.m, geom: r.geom, segDur: r.segDur, steps: r.steps };
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

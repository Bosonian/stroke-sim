// The story the map tells: when the blood is drawn, where the result arrives, and what a positive result saves.
// Pure functions. Registered model: lead time L = s + T − A (OSF osf.io/ew8fj); minutes; T at k = 1, scaled by k.

/** Minutes after departure when the result is ready: A − s (0 when blood is drawn at least A minutes before). */
export function resultMinute(s, A) {
  return Math.max(0, A - s);
}

/** Registered lead time L = s + T − A. L >= 0 counts as "result before arrival". */
export function leadTime(s, tMin, A) {
  return s + tMin - A;
}

/** Latest blood draw (s) that still beats the ambulance for a drive of tMin, in the paper's bins (Figure 2). */
export function latestDraw(tMin) {
  if (tMin >= 15) return 0;
  if (tMin >= 10) return 5;
  if (tMin >= 5) return 10;
  return 15;
}

/** Initial compass bearing from a to b ([lon, lat]), degrees 0–360, 0 = north. */
export function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/** Split a route at the point reached after targetSec of driving (k = 1).
 *  segDur: seconds per segment (OSRM annotation). Without it the share of distance is used (approximate),
 *  with totalSec as the route's duration. Past the end the point is the destination.
 *  heading: direction of the road at the point (bearing of the segment that contains it), null below 2 points. */
export function splitRoute(coords, segDur, targetSec, totalSec) {
  const n = coords.length;
  if (n < 2) return { point: coords[0], before: [coords[0]], after: coords.slice(), heading: null };
  if (targetSec <= 0) return { point: coords[0], before: [coords[0]], after: coords.slice(), heading: bearing(coords[0], coords[1]) };
  let dur = segDur;
  if (!dur || dur.length !== n - 1) {
    const len = coords.slice(1).map((c, i) => Math.hypot(c[0] - coords[i][0], c[1] - coords[i][1]));
    const total = len.reduce((a, b) => a + b, 0) || 1;
    dur = len.map((l) => (l / total) * (totalSec || 0));
  }
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = dur[i];
    if (acc + d >= targetSec && d > 0) {
      const f = (targetSec - acc) / d;
      const a = coords[i], b = coords[i + 1];
      const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      return { point: p, before: [...coords.slice(0, i + 1), p], after: [p, ...coords.slice(i + 1)], heading: bearing(a, b) };
    }
    acc += d;
  }
  return { point: coords[n - 1], before: coords.slice(), after: [coords[n - 1]], heading: bearing(coords[n - 2], coords[n - 1]) };
}

const pathLen = (c) => c.slice(1).reduce((a, p, i) => {
  const q = c[i];
  const kx = Math.cos((((p[1] + q[1]) / 2) * Math.PI) / 180);
  return a + Math.hypot((p[0] - q[0]) * kx, p[1] - q[1]);
}, 0);

/** Time (s, k = 1) and road distance (m) left on a route after `targetSec` of driving: the label of the
 *  stretch from the result point on. */
export function remainder(coords, segDur, totalSec, meters, targetSec) {
  const all = pathLen(coords);
  const after = splitRoute(coords, segDur, targetSec, totalSec).after;
  return { sec: Math.max(0, totalSec - Math.max(0, targetSec)), m: all > 0 ? Math.round((meters * pathLen(after)) / all) : 0 };
}

/** Point half way along a line by length, where its "min · km" label goes. */
export function midpoint(coords) {
  return splitRoute(coords, null, 0.5, 1).point;
}

/** What happens for one position.
 *  look: { su: { t }, ns: { t } } minutes at k = 1; same: neurosurgery is at the stroke unit's hospital;
 *  suNsMin: stroke unit → neurosurgery (k = 1) or null; pNsMin: result point → neurosurgery (k = 1) or null;
 *  stay: minutes at the stroke unit before transfer (door-in-door-out).
 *  mode: 'below' | 'same' | 'late' | 'turn'. Saving is null when a needed road time is unknown. */
export function story({ s, A, k, tier, look, same, stay, suNsMin, pNsMin }) {
  const resultMin = resultMinute(s, A);
  const tSu = look.su.t * k;
  const lead = leadTime(s, tSu, A);
  const out = { resultMin, lead, mode: 'turn', lateMin: null, withoutMin: null, withMin: null, savingMin: null, driveSavingMin: null };
  if (tier === 'below') return { ...out, mode: 'below' };
  if (same) return { ...out, mode: 'same' };
  if (lead < 0) return { ...out, mode: 'late', lateMin: -lead };
  const toNs = resultMin === 0 ? look.ns.t : pNsMin;
  if (suNsMin == null || toNs == null) return out;
  const driveWithout = tSu + suNsMin * k;
  const withMin = resultMin + toNs * k;
  return {
    ...out,
    withoutMin: driveWithout + stay,
    withMin,
    savingMin: driveWithout + stay - withMin,
    savingWhole: Math.round(driveWithout + stay) - Math.round(withMin), // what the race summary shows
    driveSavingMin: driveWithout - withMin,
  };
}

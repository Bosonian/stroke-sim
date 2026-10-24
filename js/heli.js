// Helicopter transfer between hospitals (illustrative): whether the sending stroke unit's federal state offers it
// for this transfer, and how long the flight takes. Rules and sources in config.helicopter (LOG.md, 24.10.2026).

const R_EARTH_KM = 6371;

/** Straight-line km between two [lon, lat] points. */
export function kmLine(a, b) {
  const r = Math.PI / 180;
  const x = (b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r);
  const y = (b[1] - a[1]) * r;
  return Math.hypot(x, y) * R_EARTH_KM;
}

/** The state rule that offers a helicopter for this transfer, or null.
 *  Hessen: > 75 km straight line (the rule), or > 40 km for an immediate transfer when both hospitals have a helipad
 *  (no ambulance leg); Baden-Württemberg: > 80 km by road; Bavaria: up to 120 km straight line; other states: none. */
export function heliOffer({ state, kmLine: line, kmRoad, suLanding, nsLanding }, cfg) {
  const rule = cfg.rules[state];
  if (!rule) return null;
  const offer = (basis) => ({ state, basis });
  if (state === 'Hessen') {
    if (line > rule.regularKm) return offer('regular');
    return line > rule.immediateKm && suLanding === 'helipad' && nsLanding === 'helipad' ? offer('immediate') : null;
  }
  if (state === 'Baden-Württemberg') return kmRoad != null && kmRoad > rule.roadKm ? offer('road') : null;
  if (state === 'Bayern') return line <= rule.maxKm ? offer('within') : null;
  return null;
}

/** Minutes from leaving the stroke unit to arriving at neurosurgery: straight line at cfg.speedKmh (warm-up and
 *  landing included), plus an ambulance leg at each hospital without a helipad. */
export function flightMinutes(line, suLanding, nsLanding, cfg) {
  const legs = [suLanding, nsLanding].filter((l) => l !== 'helipad').length;
  return (line / cfg.speedKmh) * 60 + legs * cfg.groundLegMin;
}

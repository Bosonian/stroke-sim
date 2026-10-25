// Decision for the current square and the shown result (design section 7.2). Minutes at k = 1; callers scale.

/** null without data; otherwise the tier, target ('su' | 'ns' | 'both'), options and detour versus the stroke unit. */
export function decide(look, shown, cfg) {
  if (!look) return null;
  const tier = cfg.tiers[shown];
  let target = 'su';
  if (tier.positive) {
    // the combined-centre comparison needs its own routes; without them it is not made (see config.combinedRoutes)
    target = cfg.combinedRoutes && look.both && look.both.t - look.ns.t <= cfg.bothMaxExtraMin ? 'both' : 'ns';
  }
  return {
    tier,
    target,
    options: look,
    detourMin: look[target].t - look.su.t,
  };
}

/** Whole minutes over the k range, and at the chosen k. */
export function range(tMin, kValues, k) {
  return {
    lo: Math.round(tMin * Math.min(...kValues)),
    mid: Math.round(tMin * k),
    hi: Math.round(tMin * Math.max(...kValues)),
  };
}

export function fmtDetour(min, lang) {
  const m = Math.round(min);
  if (m === 0) return lang === 'de' ? 'kein Umweg' : 'no detour';
  if (m > 0) return `+${m} min`;
  return lang === 'de' ? `${-m} min näher` : `${-m} min nearer`;
}

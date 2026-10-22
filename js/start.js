// The start box: place, test result and blood-draw time are chosen before the race; the map stays blurred until Start.

/** Results offered in the box: the three tiers with an action (consensus of the survey of 94 neurologists). */
export const START_TIERS = ['t71', 't81', 't91'];

/** sel = { placed, tier, draw }; draws = the offered blood-draw times (minutes before departure). */
export function canStart(sel, draws) {
  return !!sel.placed && START_TIERS.includes(sel.tier) && draws.includes(sel.draw);
}

/** After Start: 'wait' for road routes, 'go', or 'blocked' (the race cannot run here; the box says why). */
export function startDecision({ livePending, blocker }) {
  if (livePending || blocker === 'loading') return 'wait';
  return blocker ? 'blocked' : 'go';
}

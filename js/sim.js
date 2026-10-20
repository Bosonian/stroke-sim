// Simulation clock and phases. Pure functions on a plain state object; all times in minutes since the
// scenario started: { t, testStart, leaveAt, resultAt, result, k, A, leg }.
// leg (in transit only): { key, from, drive } = the drive that started at minute `from` and takes `drive` minutes.
// The ambulance does not move by itself; the presenter moves it, and each new position, target or speed starts a new leg.
// result is the presenter's chosen outcome: 'pending' | 'below' | 't71' | 't81' | 't91'.

/** Time the result appears: the set time, else test start + A; null before the test is started. */
export function expectedResultAt(s) {
  if (s.testStart == null) return null;
  return s.resultAt ?? s.testStart + s.A;
}

/** The result the crew can see now. */
export function resultShown(s) {
  const at = expectedResultAt(s);
  return at != null && s.t >= at ? s.result : 'pending';
}

export function atScene(s) {
  return s.leaveAt == null || s.t < s.leaveAt;
}

export function phase(s, arrived) {
  const shown = resultShown(s);
  if (arrived) return shown === 'pending' ? 'arrived-pending' : 'arrived-result';
  if (s.testStart == null || s.t < s.testStart) return 'idle';
  return shown === 'pending' ? 'running' : 'result';
}

/** Will the result be there by arrival (L >= 0, as in the model)? null without a running test.
 *  At the scene without a planned departure, departure is assumed to be now. */
export function likelyBeforeArrival(s, driveLeftMin) {
  const at = expectedResultAt(s);
  if (at == null) return null;
  return at <= arrivalAt(s, driveLeftMin);
}

/** Estimated arrival minute. At the scene without a planned departure, departure is assumed to be now.
 *  In transit with a leg, arrival is fixed by that leg and does not slide with the clock. */
export function arrivalAt(s, driveLeftMin) {
  if (!atScene(s) && s.leg) return s.leg.from + s.leg.drive;
  const depart = atScene(s) ? Math.max(s.t, s.leaveAt ?? s.t) : s.t;
  return depart + driveLeftMin;
}

/** The current leg. key identifies position, target and speed; a new key starts a new leg now. Before the
 *  current leg's start (scrubbing back) the leg restarts at departure. null at the scene. */
export function updateLeg(s, key, driveMin) {
  if (atScene(s)) return null;
  if (!s.leg || s.t < s.leg.from) return { key, from: s.leaveAt, drive: driveMin };
  if (s.leg.key !== key) return { key, from: s.t, drive: driveMin };
  return s.leg;
}

/** Illustrative imaging start: arrival plus a door-to-imaging time (literature context, not part of the model). */
export function imagingFrom(s, driveLeftMin, doorToImagingMin) {
  return arrivalAt(s, driveLeftMin) + doorToImagingMin;
}

/** Imaging start at the lower quartile, median and upper quartile of door-to-imaging (Weiss et al. 2024: 21/32/50). */
export function imagingTimes(s, driveLeftMin, d) {
  return {
    fast: imagingFrom(s, driveLeftMin, d.p25),
    median: imagingFrom(s, driveLeftMin, d.median),
    slow: imagingFrom(s, driveLeftMin, d.p75),
  };
}

/** Minutes between the biomarker result and imaging at the given door-to-imaging time.
 *  Negative when the result comes after imaging; null without a running test. */
export function decisionWindow(s, driveLeftMin, doorToImagingMin) {
  const at = expectedResultAt(s);
  if (at == null) return null;
  return imagingFrom(s, driveLeftMin, doorToImagingMin) - at;
}

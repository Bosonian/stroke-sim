// Simulation clock and phases. Pure functions on a plain state object; all times in minutes since the
// scenario started: { t, testStart, leaveAt, resultAt, result, k, A }.
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

/** Estimated arrival minute. At the scene without a planned departure, departure is assumed to be now. */
export function arrivalAt(s, driveLeftMin) {
  const depart = atScene(s) ? Math.max(s.t, s.leaveAt ?? s.t) : s.t;
  return depart + driveLeftMin;
}

/** Earliest likely start of imaging: arrival plus the lower end of the door-to-imaging IQR
 *  (21 min; Weiss et al. 2024, one German city). Literature context, not part of the registered model. */
export function imagingFrom(s, driveLeftMin, doorToImagingMin) {
  return arrivalAt(s, driveLeftMin) + doorToImagingMin;
}

/** Minutes between the biomarker result and the earliest likely imaging: the time in which the GFAP result is the
 *  only basis for a decision. Negative when the result comes after imaging; null without a running test. */
export function decisionWindow(s, driveLeftMin, doorToImagingMin) {
  const at = expectedResultAt(s);
  if (at == null) return null;
  return imagingFrom(s, driveLeftMin, doorToImagingMin) - at;
}

// The race: the same ambulance with the prehospital test (red) and without it (grey), minute by minute.
// Pure functions (spec docs/superpowers/specs/2026-10-21-race-design.md). Minutes after departure; drive times
// are given at k = 1 and multiplied by k; the test time and the waits (scan, stay at the stroke unit) are not.
import { resultMinute, splitRoute } from './story.js?v=36';

const TREATS = { below: [], t71: ['bp'], t81: ['bp'], t91: ['bp', 'reversal'] };
const PREHOSPITAL = { below: [], t71: [], t81: ['bp'], t91: ['bp', 'reversal'] };

/** Event times and driven legs for both lanes.
 *  mode: from story() ('turn' | 'late' | 'same' | 'below'); tSu, suNs, nsDirect, pNs: minutes at k = 1
 *  (suNs null without a transfer; pNs from the result point when r > 0; nsDirect from the start when r = 0);
 *  scan: door-to-image; stay: door-in-door-out; decide: from the first scan to the decision (surgery or conservative);
 *  outcome: 'surgery' (default) or 'conservative' (illustrative replay: no transfer, the dots stay where they are). */
export function raceSchedule({ s, A, k, tier, mode, tSu, suNs, nsDirect, pNs, scan, stay, decide = 0, outcome = 'surgery' }) {
  const r = resultMinute(s, A);
  const su = tSu * k;
  const conservative = outcome === 'conservative' && mode !== 'below';
  const transfer = mode !== 'same' && mode !== 'below' && suNs != null && !conservative;
  const treats = TREATS[tier] || [];

  // without the test: stroke unit, scan (treatment), transfer after the door-in-door-out time
  const wo = { events: [{ key: 'depart', min: 0 }, { key: 'su', min: su }, { key: 'scan', min: su + scan }], legs: [{ from: 0, to: su, route: 'su' }] };
  treats.forEach((key) => wo.events.push({ key, min: su + scan }));
  // surgery or conservative: decided after the first scan, on its images (sent to the neurosurgeons; no second scan after a transfer)
  if (mode !== 'below') wo.events.push({ key: 'decision', min: su + scan + decide });
  if (transfer) {
    const ns = su + stay + suNs * k;
    wo.events.push({ key: 'transferLeaves', min: su + stay }, { key: 'ns', min: ns });
    wo.legs.push({ from: su + stay, to: ns, route: 'transfer' });
  }

  // with the test
  const wi = { events: [{ key: 'drawn', min: -s }, { key: 'depart', min: 0 }, { key: 'result', min: r }], legs: [] };
  let arrive; // arrival at the hospital where a scan would happen
  if (mode === 'turn') {
    arrive = r === 0 ? nsDirect * k : r + pNs * k;
    wi.legs = r === 0 ? [{ from: 0, to: arrive, route: 'branch' }] : [{ from: 0, to: r, route: 'su' }, { from: r, to: arrive, route: 'branch' }];
    wi.events.push({ key: 'ns', min: arrive }, { key: 'scan', min: arrive + scan }, { key: 'decision', min: arrive + scan + decide }); // imaging still happens, at neurosurgery
  } else {
    arrive = su;
    wi.legs = wo.legs.map((l) => ({ ...l }));
    wi.events.push(...wo.events.filter((e) => ['su', 'scan', 'transferLeaves', 'ns', 'decision'].includes(e.key)).map((e) => ({ ...e })));
  }
  treats.forEach((key) => {
    if (PREHOSPITAL[tier].includes(key) && r < arrive + scan) wi.events.push({ key, min: r });
    else wi.events.push({ key, min: arrive + scan, afterScan: true });
  });

  const at = (lane, key) => lane.events.find((e) => e.key === key)?.min;
  const diff = (key) => (at(wo, key) != null && at(wi, key) != null ? at(wo, key) - at(wi, key) : null);
  const all = [...wi.events, ...wo.events].map((e) => e.min);
  const same = mode === 'same'; // the stroke unit has neurosurgery: arriving there is arriving at neurosurgery
  if (same) wi.sameSite = wo.sameSite = true;
  return { start: -s, end: Math.max(...all), with: wi, without: wo, diff: { ns: diff('ns'), bp: diff('bp') }, same, ...(conservative ? { conservative } : {}) };
}

/** What a dot is doing at minute `min`, for the live heading: 'scene' | 'testScene' | 'testDriving' | 'resultDriving' |
 *  'toSu' | 'toNs' | 'doorToImage' | 'waitTransfer' | 'transfer' | 'imaged' | 'imagedNs'. */
export function phaseAt(lane, min) {
  const at = (key) => lane.events.find((e) => e.key === key)?.min;
  const result = at('result');
  const leg = lane.legs.find((l) => min >= l.from && min < l.to);
  if (leg) {
    if (leg.route === 'branch') return 'toNs';
    if (leg.route === 'transfer') return 'transfer';
    if (result == null) return 'toSu';
    return min < result ? 'testDriving' : 'resultDriving';
  }
  if (min < 0) return result != null ? 'testScene' : 'scene';
  // at a hospital
  const scan = at('scan');
  const leaves = at('transferLeaves');
  const ns = at('ns');
  if (scan != null && min < scan) return 'doorToImage';
  if (leaves != null && min < leaves) return 'waitTransfer';
  return (ns != null && min >= ns) || lane.sameSite ? 'imagedNs' : 'imaged';
}

/** Where a dot is at minute `min`: along its current leg, standing still between and after legs.
 *  routes[name] = { coords, segDur (s per segment at k = 1, or null), sec (route duration at k = 1) }. */
export function positionAt(legs, min, k, routes) {
  if (!legs.length) return null;
  const along = (leg, m) => {
    const rt = routes[leg.route];
    const sec = rt.sec != null ? rt.sec : ((leg.to - leg.from) * 60) / k;
    // a leg that starts mid-route (the branch) has its own route from its start point
    return splitRoute(rt.coords, rt.segDur, ((m - leg.from) * 60) / k, sec).point;
  };
  if (min <= legs[0].from) return along(legs[0], legs[0].from);
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (min <= leg.to) return along(leg, Math.max(min, leg.from));
    const next = legs[i + 1];
    if (!next || min < next.from) return along(leg, leg.to);
  }
  return along(legs[legs.length - 1], legs[legs.length - 1].to);
}

const FAST = 10; // min per s while nobody drives or once the red dot has arrived
const NORMAL = 2; // min per s before departure and while the red dot drives

/** Clock speed over the race: [{ min0, min1, rate }] from start to end. */
export function clockSegments(sched) {
  const cuts = new Set([sched.start, 0, sched.end]);
  [...sched.with.legs, ...sched.without.legs].forEach((l) => { cuts.add(l.from); cuts.add(l.to); });
  const pts = [...cuts].filter((m) => m >= sched.start && m <= sched.end).sort((a, b) => a - b);
  const redDriving = (m) => sched.with.legs.some((l) => m > l.from && m < l.to);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    if (b <= a) continue;
    const mid = (a + b) / 2;
    const rate = mid < 0 || redDriving(mid) ? NORMAL : FAST;
    const last = out[out.length - 1];
    if (last && last.rate === rate) last.min1 = b;
    else out.push({ min0: a, min1: b, rate });
  }
  return out;
}

/** Model minute shown after `sec` seconds of playback. */
export function minuteAt(segments, sec) {
  let left = sec;
  for (const g of segments) {
    const dur = (g.min1 - g.min0) / g.rate;
    if (left <= dur) return g.min0 + left * g.rate;
    left -= dur;
  }
  return segments.length ? segments[segments.length - 1].min1 : 0;
}

/** Playback seconds at model minute `min` (the inverse of minuteAt). */
export function secondsAt(segments, min) {
  let sec = 0;
  for (const g of segments) {
    if (min <= g.min1) return sec + Math.max(0, min - g.min0) / g.rate;
    sec += (g.min1 - g.min0) / g.rate;
  }
  return sec;
}

export function totalSeconds(segments) {
  return segments.reduce((a, g) => a + (g.min1 - g.min0) / g.rate, 0);
}

/** Why the race cannot run now, or null. A re-route is needed only when the ambulance turns;
 *  the road from the stroke unit to neurosurgery whenever the grey dot is transferred (turn, late). */
export function raceBlocker({ live, mode, branch, transfer = true }) {
  if (!live) return 'offline';
  if (mode === 'turn' && branch === undefined) return 'loading';
  if (mode === 'turn' && !branch) return 'noRoute';
  if ((mode === 'turn' || mode === 'late') && !transfer) return 'noTransfer';
  return null;
}

const MILESTONES = ['drawn', 'depart', 'result', 'su', 'scan', 'transferLeaves', 'ns', 'decision'];

/** End summary: milestones in time order, labelled intervals, treatment marks and differences.
 *  Minutes are rounded once, here, so the intervals add up and the differences match the time points. */
export function summaryRows(sched) {
  const rows = (lane) => lane.events.filter((e) => MILESTONES.includes(e.key)).map((e) => ({ key: e.key, min: Math.round(e.min) }))
    .sort((a, b) => a.min - b.min);
  const gaps = (ms) => {
    const at = (key) => ms.find((m) => m.key === key);
    const out = [];
    const gap = (from, to, kind) => { if (from && to && to.min > from.min) out.push({ from: from.key, to: to.key, min: to.min - from.min, kind }); };
    const dep = at('depart'), su = at('su'), leaves = at('transferLeaves'), ns = at('ns'), res = at('result');
    if (su) {
      gap(dep, su, 'drive');
      gap(su, leaves, 'atSu');
      gap(leaves, ns, 'transfer');
    } else if (ns) {
      if (res && res.min > 0) { gap(dep, res, 'drive'); gap(res, ns, 'drive'); } else gap(dep, ns, 'drive');
    }
    return out;
  };
  const w = rows(sched.with), wo = rows(sched.without);
  const treat = (lane) => lane.events.filter((e) => e.key === 'bp' || e.key === 'reversal').map((e) => ({ ...e, min: Math.round(e.min) }));
  const tw = treat(sched.with), two = treat(sched.without);
  const at = (list, key) => list.find((e) => e.key === key)?.min;
  const diffs = [['bp', tw, two], ['ns', w, wo]].filter(([key, a, b]) => at(a, key) != null && at(b, key) != null)
    .map(([key, a, b]) => ({ key, min: at(b, key) - at(a, key) }));
  return { with: w, without: wo, gaps: { with: gaps(w), without: gaps(wo) }, treatments: { with: tw, without: two }, diffs };
}

const TIMELINE = ['drawn', 'result', 'first', 'scan', 'decision', 'transferLeaves'];
export const COMPARED = ['ns', 'bp', 'reversal'];

/** End table. First the timeline (blood draw, result, first hospital, scan, transfer), in time order in both
 *  lanes; then the compared rows (arrival at neurosurgery, treatment starts) with the difference. Each cell has
 *  the lane's minute and the interval that led to it; the first hospital says which one; a treatment says
 *  where it starts (in the ambulance, at the hospital before the scan, or after the scan). */
export function summaryTable(sched) {
  const sum = summaryRows(sched);
  const ms = (lane, key) => sum[lane].find((x) => x.key === key);
  const gapTo = (lane, key) => {
    const g = sum.gaps[lane].find((x) => x.to === key);
    return g ? { kind: g.kind, min: g.min } : null;
  };
  const firstOf = (lane) => (ms(lane, 'su') ? 'su' : ms(lane, 'ns') ? 'ns' : null);
  const cell = (lane, key) => {
    if (key === 'first') {
      const p = firstOf(lane);
      return p ? { min: ms(lane, p).min, place: sched.same ? 'suNs' : p, gap: gapTo(lane, p) } : null;
    }
    const m = ms(lane, key) || (key === 'ns' && sched.same ? { min: ms(lane, 'su').min } : null);
    // arrival at neurosurgery repeats the first-hospital row after a turn; its drive is shown there
    if (m) return { min: m.min, gap: key === 'ns' && (firstOf(lane) === 'ns' || sched.same) ? null : gapTo(lane, key) };
    const t = sum.treatments[lane].find((x) => x.key === key);
    if (!t) return null;
    const arrive = firstOf(lane) ? ms(lane, firstOf(lane)).min : Infinity;
    return { min: t.min, where: t.afterScan || lane === 'without' ? 'afterScan' : t.min <= arrive ? 'ambulance' : 'beforeScan' };
  };
  const rows = [...TIMELINE, ...COMPARED].map((key) => {
    const w = cell('with', key), wo = cell('without', key);
    return { key, with: w, without: wo, diff: w && wo && COMPARED.includes(key) ? wo.min - w.min : null };
  }).filter((row) => row.with || row.without);
  // a result after arrival (too late to change the destination) is listed after the arrival
  const iRes = rows.findIndex((x) => x.key === 'result'), iFirst = rows.findIndex((x) => x.key === 'first');
  if (iRes >= 0 && iFirst === iRes + 1 && rows[iFirst].with && rows[iRes].with.min > rows[iFirst].with.min) {
    [rows[iRes], rows[iFirst]] = [rows[iFirst], rows[iRes]];
  }
  return rows;
}

/** Door-to-image clocks: one per hospital a dot reaches, [{ lane, arrive, scan, leaves, decided }] (leaves: the transfer,
 *  or null; decided: the decision minute where the dot stays, else null).
 *  The grey dot's at the stroke unit; the red dot's only after a turn (otherwise both dots share the stroke unit). */
export function doorWatches(sched) {
  const at = (lane, key) => sched[lane].events.find((e) => e.key === key)?.min;
  const out = [];
  const flag = sched.conservative ? { conservative: true } : {};
  if (at('without', 'su') != null) {
    out.push({ lane: 'without', arrive: at('without', 'su'), scan: at('without', 'scan'), leaves: at('without', 'transferLeaves') ?? null, decided: at('without', 'transferLeaves') == null ? at('without', 'decision') ?? null : null, ...flag });
  }
  if (at('with', 'su') == null && at('with', 'ns') != null && at('with', 'scan') != null) {
    out.push({ lane: 'with', arrive: at('with', 'ns'), scan: at('with', 'scan'), leaves: null, decided: at('with', 'decision') ?? null, ...flag });
  }
  return out;
}

/** Text of a door-to-image chip at minute `min`: running until the scan, then the decision where the dot stays, or
 *  (stroke unit before a transfer) the time there until the transfer leaves. */
export function doorChip(min, { arrive, scan, leaves, decided = null, conservative = false }, L, time = null) {
  const m = Math.max(0, Math.floor(min - arrive));
  const at = (text, t) => (time ? `${text} ${time(t)}` : text); // pinned milestones with their clock time
  if (min < scan) return L.doorToImage(m, Math.round(scan - arrive));
  if (leaves == null) return decided != null && min >= decided ? at(conservative ? L.decidedConservative : L.decided, decided) : at(L.scanDone, scan);
  return min < leaves ? `${L.organising} · ${L.stopwatch(m)}` : at(L.transferLeaves, leaves); // scan done, transfer being organised
}

/** The other decision to offer on the end card: 'conservative' when it would cancel a transfer, 'surgery' to go back,
 *  or null where it changes nothing (no transfer, or no result to act on). */
export function outcomeSwitch(sched, outcome) {
  if (outcome === 'conservative') return 'surgery';
  return sched.without.events.some((e) => e.key === 'transferLeaves') ? 'conservative' : null;
}

/** Minute at which the race stops to ask for the decision: the grey dot's, where a transfer hangs on it; else null. */
export function decisionPause(sched) {
  if (sched.conservative || outcomeSwitch(sched, 'surgery') !== 'conservative') return null;
  return sched.without.events.find((e) => e.key === 'decision')?.min ?? null;
}

const MOVING = ['scene', 'testScene', 'testDriving', 'resultDriving', 'toSu', 'toNs', 'transfer'];

/** The label riding with a dot: its phase while on scene or on the road; null at a hospital (the chips there say it). */
export function dotPhase(phase) {
  return MOVING.includes(phase) ? phase : null;
}

/** "N min sooner" / "N min later" / "same time" (whole minutes). */
export function diffText(min, L) {
  const n = Math.round(min);
  if (n === 0) return L.sameTime;
  return n > 0 ? L.sooner(n) : L.later(-n);
}

/** "12:43": clock time at race minute `min` (minutes after departure). The assessment starts at clock.startMin
 *  (minutes after midnight), blood is drawn clock.assessMin later, the ambulance leaves s minutes after that. */
export function wallTime(min, s, clock) {
  const t = Math.round(clock.startMin + clock.assessMin + s + min);
  const h = Math.floor(t / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const LAP_KEYS = ['assess', 'drawn', 'depart', 'result', 'su', 'ns', 'scan', 'decision', 'bp', 'reversal', 'transferLeaves'];

/** Lap list: [{ key, min, lane: 'with' | 'without' | 'both', inAmbulance? }] in time order, starting with the
 *  assessment (`assessMin` before the blood draw); a milestone both dots reach at the same minute appears once. */
export function laps(sched, assessMin) {
  const out = [{ key: 'assess', min: sched.start - assessMin, lane: 'both' }];
  const seen = new Map();
  for (const lane of ['with', 'without']) {
    const events = sched[lane].events;
    const firstDoor = Math.min(...events.filter((e) => e.key === 'su' || e.key === 'ns').map((e) => e.min));
    for (const e of events) {
      if (!LAP_KEYS.includes(e.key)) continue;
      const id = `${e.key}@${e.min.toFixed(4)}`;
      if (seen.has(id)) { seen.get(id).lane = 'both'; continue; }
      const lap = { key: e.key, min: e.min, lane };
      if ((e.key === 'bp' || e.key === 'reversal') && e.min < firstDoor) lap.inAmbulance = true;
      seen.set(id, lap);
      out.push(lap);
    }
  }
  return out.sort((a, b) => a.min - b.min || LAP_KEYS.indexOf(a.key) - LAP_KEYS.indexOf(b.key));
}

/** One dot's lap timer: its own milestones plus the shared ones (assessment, departure), in time order. */
export function laneLaps(list, lane) {
  return list.filter((l) => l.lane === lane || l.lane === 'both');
}

/** The milestones at a dot's most recent milestone minute up to `min` (several can fall on one minute); [] before any. */
export function latestLaps(list, min) {
  const past = list.filter((l) => l.min <= min + 1e-9);
  if (!past.length) return [];
  const last = past[past.length - 1].min;
  return past.filter((l) => l.min === last);
}

/** Minute of the day of a clock time (seconds dropped): the race clock starts at the time the race starts. */
export function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const mercLat = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

/** [[west, south], [east, north]] holding all points with `origin` in its middle on the web map (Mercator),
 *  so a fit to it keeps the scene in the centre; the point farthest from the scene sets the size. */
export function centredBox(points, origin) {
  const [ox, oy] = [origin[0], mercY(origin[1])];
  let dx = 0, dy = 0;
  for (const [x, lat] of points) {
    dx = Math.max(dx, Math.abs(x - ox));
    dy = Math.max(dy, Math.abs(mercY(lat) - oy));
  }
  if (!dx && !dy) return [origin, origin];
  return [[ox - dx, mercLat(oy - dy)], [ox + dx, mercLat(oy + dy)]];
}

/** Side for a dot's label: the preferred side ('right' | 'left') unless the label would run past the screen edge
 *  there and fits on the other side. x: dot centre on screen, w: label width, width: map width (px). */
export function labelSide(prefer, x, w, width, gap = 18, margin = 8) {
  const right = x + gap + w <= width - margin;
  const left = x - gap - w >= margin;
  if (prefer === 'right') return right || !left ? 'right' : 'left';
  return left || !right ? 'left' : 'right';
}

// Stroke routing simulator: map, draggable ambulance, simulation clock and the decision read-out.
// Logic lives in sim.js / decide.js (tested); this file wires it to the page.
/* global maplibregl */
import { config } from '../config.js';
import { strings } from './i18n.js';
import { loadGrid } from './grid.js';
import { hospitalFeatures, siteKind } from './hospitals.js';
import { expectedResultAt, resultShown, atScene, likelyBeforeArrival, arrivalAt, imagingFrom, decisionWindow } from './sim.js';
import { decide, range, fmtDetour } from './decide.js';

const KIND_COLOR = { su: '#0072B2', ns: '#CC79A7', both: '#009E73' };
const BASE_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const FALLBACK_STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#E9EDF1' } }],
};
const RATES = [1, 5, 20];
const MAX_MIN = 120;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const initial = () => ({ t: 0, testStart: null, leaveAt: null, resultAt: null, result: 'pending', k: config.kDefault, A: config.A });
const state = initial();
const ui = {
  lang: store.get('sim-lang') === 'de' ? 'de' : 'en',
  playing: false,
  rate: 5,
  pos: { ...config.start },
  grid: null,
  hospitals: [],
  map: null,
  marker: null,
};
const L = () => strings[ui.lang];

// ---------- static text and controls ----------
function applyStatic() {
  const s = L();
  document.documentElement.lang = ui.lang;
  document.title = s.title;
  document.querySelectorAll('[data-t]').forEach((el) => {
    const v = s[el.dataset.t];
    if (typeof v === 'string') el.textContent = v;
  });
  $('playBtn').textContent = ui.playing ? s.pause : s.play;
  buildSegment('resultSeg', 'result', config.results, (v) => s.results[v], state.result);
  buildSegment('speedSeg', 'speed', config.kValues, (v) => s.speeds[v], state.k);
  $('legend').innerHTML = ['su', 'ns', 'both']
    .map((k) => `<li><i style="background:${KIND_COLOR[k]}"></i>${esc(s.legend[k])}</li>`).join('');
  $('estimateNote').textContent = `${s.estimateNote} ${s.connectorNote}`;
  $('aboutBody').innerHTML = [...s.aboutBody, s.imagingNote, `${s.gapNote}`, config.model.source]
    .map((p) => `<p>${esc(p)}</p>`).join('');
}

function buildSegment(id, name, values, label, current) {
  const fs = $(id);
  fs.querySelectorAll('label').forEach((l) => l.remove());
  for (const v of values) {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="radio" name="${name}" value="${v}"${String(v) === String(current) ? ' checked' : ''}><span>${esc(label(v))}</span>`;
    fs.appendChild(lab);
  }
}

function buildRates() {
  $('rateSeg').innerHTML = RATES.map((r) => `<button type="button" data-rate="${r}" aria-pressed="${r === ui.rate}">${r}×</button>`).join('');
}

// ---------- map ----------
function ambulanceEl() {
  const el = document.createElement('div');
  el.className = 'ambulance';
  el.setAttribute('aria-label', 'Ambulance');
  el.innerHTML = `<svg viewBox="0 0 46 46" aria-hidden="true">
    <rect x="14" y="4" width="18" height="38" rx="4" fill="#ffffff" stroke="#13273F" stroke-width="1.5"/>
    <rect x="14" y="22" width="18" height="5" fill="#F2342B"/>
    <rect x="16" y="9" width="14" height="3" rx="1.5" fill="#2F7DE1"/>
    <rect x="17" y="30" width="12" height="9" rx="1.5" fill="none" stroke="#F2342B" stroke-width="1.6"/>
    <path d="M23 31.5v6M20 34.5h6" stroke="#F2342B" stroke-width="1.6"/>
  </svg>`;
  return el;
}

function addLayers(map) {
  if (map.getSource('hospitals')) return;
  map.addSource('links', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('hospitals', { type: 'geojson', data: hospitalFeatures(ui.hospitals) });
  map.addLayer({
    id: 'links-alt', type: 'line', source: 'links', filter: ['==', ['get', 'role'], 'alt'],
    paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.55, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'links-target', type: 'line', source: 'links', filter: ['==', ['get', 'role'], 'target'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'hospitals', type: 'circle', source: 'hospitals',
    paint: {
      'circle-color': ['match', ['get', 'kind'], 'su', KIND_COLOR.su, 'ns', KIND_COLOR.ns, KIND_COLOR.both],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3.2, 7, 5, 10, 8, 13, 11],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 10, 2],
    },
  });
  map.addLayer({
    id: 'hospital-labels', type: 'symbol', source: 'hospitals', minzoom: 8.5,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12.5,
      'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 12, 'text-optional': true,
    },
    paint: { 'text-color': '#18222F', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
  });
}

function hospitalPopup(e) {
  const p = e.features[0].properties;
  const h = ui.hospitals[p.idx];
  const s = L();
  new maplibregl.Popup({ offset: 10 })
    .setLngLat(e.lngLat)
    .setHTML(`<p class="pop-name">${esc(h.name)}</p><p class="pop-meta">${esc(h.city)}. ${esc(s.kinds[p.kind])}</p>`
      + (h.detail ? `<p class="pop-meta">${esc(h.detail)}</p>` : '')
      + `<p class="pop-note">${esc(s.gapNote)}</p>`)
    .addTo(ui.map);
}

function initMap() {
  const phone = window.matchMedia('(max-width: 899px)').matches;
  const map = new maplibregl.Map({
    container: 'map',
    style: BASE_STYLE,
    center: phone ? [ui.pos.lon, ui.pos.lat] : [10.4, 51.1],
    zoom: phone ? 6.4 : 5.6,
    minZoom: 4,
    maxZoom: 15,
    maxBounds: [[1.5, 45.5], [19.5, 56.5]],
    attributionControl: { compact: true },
  });
  ui.map = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  // phone: keep the ambulance visible above the bottom sheet
  const pad = () => {
    if (!window.matchMedia('(max-width: 899px)').matches) return map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.setPadding({ top: 0, left: 0, right: 0, bottom: $('panel').offsetHeight });
  };
  pad();
  map.jumpTo({ center: [ui.pos.lon, ui.pos.lat] });
  window.addEventListener('resize', pad);
  $('panel').addEventListener('transitionend', () => { pad(); map.easeTo({ center: [ui.pos.lon, ui.pos.lat], duration: 300 }); });

  let fellBack = false;
  const fallback = () => {
    if (fellBack) return;
    fellBack = true;
    map.setStyle(FALLBACK_STYLE);
  };
  map.on('error', () => { if (!map.isStyleLoaded()) fallback(); });
  setTimeout(() => { if (!map.isStyleLoaded()) fallback(); }, 8000);
  map.on('style.load', () => { addLayers(map); update(); });
  map.on('click', 'hospitals', hospitalPopup);
  map.on('mouseenter', 'hospitals', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'hospitals', () => { map.getCanvas().style.cursor = ''; });

  ui.marker = new maplibregl.Marker({ element: ambulanceEl(), draggable: true })
    .setLngLat([ui.pos.lon, ui.pos.lat])
    .addTo(map);
  let pending = false;
  const follow = () => {
    const ll = ui.marker.getLngLat();
    ui.pos = { lon: ll.lng, lat: ll.lat };
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => { pending = false; update(); });
    }
  };
  // tap or click anywhere on the map moves the ambulance there (taps on a hospital open its details instead)
  map.on('click', (e) => {
    if (map.getLayer('hospitals') && map.queryRenderedFeatures(e.point, { layers: ['hospitals'] }).length) return;
    ui.marker.setLngLat(e.lngLat);
    follow();
  });
  ui.marker.on('drag', follow);
  ui.marker.on('dragend', follow);
}

// ---------- the decision read-out ----------
function setLinks(features) {
  const src = ui.map && ui.map.getSource('links');
  if (src) src.setData({ type: 'FeatureCollection', features });
}

function link(role, h, kind) {
  return {
    type: 'Feature',
    properties: { role, color: KIND_COLOR[kind] },
    geometry: { type: 'LineString', coordinates: [[ui.pos.lon, ui.pos.lat], [h.lon, h.lat]] },
  };
}

function optionLine(key, opt, d) {
  const s = L();
  const h = ui.hospitals[opt.idx];
  const r = range(opt.t, config.kValues, state.k);
  const detour = fmtDetour((opt.t - d.options.su.t) * state.k, ui.lang);
  return `<span>${esc(s.target[key])}: <b>${esc(h.name)}</b>, ${r.mid} min (${r.lo}–${r.hi}), ${esc(detour)}</span>`;
}

function update() {
  const s = L();
  const shown = resultShown(state);
  const exp = expectedResultAt(state);
  const look = ui.grid ? ui.grid.lookup(ui.pos.lon, ui.pos.lat) : null;
  const d = decide(look, shown, config);

  // clock
  $('clockMin').textContent = state.t.toFixed(1);
  $('scrub').value = state.t;
  $('whereLine').textContent = atScene(state) ? s.atScene : s.inTransit;
  $('testLine').textContent = state.testStart == null || state.t < state.testStart ? s.testIdle
    : shown !== 'pending' ? s.testResult : s.testRunning(Math.floor(state.t - state.testStart));
  $('expectLine').textContent = exp != null && shown === 'pending' ? s.expectedAt(Math.round(exp)) : '';
  $('startBtn').disabled = state.testStart != null;
  $('leaveBtn').disabled = state.leaveAt != null;
  if (document.activeElement !== $('resultAt')) $('resultAt').value = exp != null ? Math.round(exp) : '';

  // tier
  const tier = config.tiers[shown];
  $('decision').dataset.tier = shown;
  $('tierLine').textContent = shown === 'pending' ? s.tierPending
    : shown === 'below' ? s.tierBelow : `ICH ${s.results[shown]}`;
  $('actionList').innerHTML = tier.actions.map((a) => `<li>${esc(s.actions[a])}</li>`).join('');

  const show = (on) => { $('targetBlock').hidden = !on; };
  $('likelyLine').textContent = '';
  $('windowLine').innerHTML = '';
  $('imagingLine').textContent = '';
  $('fpLine').textContent = '';
  $('altBlock').innerHTML = '';
  if (!ui.grid) {
    show(false);
    $('noticeLine').textContent = `${s.noData} ${s.dragHint}`;
    setLinks([]);
    return;
  }
  if (!d) {
    show(false);
    $('noticeLine').textContent = s.noRoad;
    setLinks([]);
    return;
  }
  show(true);
  $('noticeLine').textContent = '';
  const tgt = d.options[d.target];
  const h = ui.hospitals[tgt.idx];
  const kind = siteKind(ui.hospitals, tgt.idx);
  const r = range(tgt.t, config.kValues, state.k);
  $('targetKind').textContent = s.target[d.target];
  $('targetKind').style.setProperty('--kind', KIND_COLOR[kind]);
  $('targetName').textContent = `${h.name}, ${h.city}`;
  $('targetMeta').innerHTML = `${esc(s.drive)} <b>${r.mid} min</b> (${r.lo}–${r.hi})`
    + (d.target === 'su' ? '' : `<br>${esc(fmtDetour(d.detourMin * state.k, ui.lang))} ${esc(s.detourVsSu)}`);
  $('targetSu').textContent = d.target === 'su' ? '' : kind === 'both' ? s.hasSu : s.noSu;

  const driveLeft = tgt.t * state.k;
  const likely = likelyBeforeArrival(state, driveLeft);
  if (likely != null && shown === 'pending') $('likelyLine').textContent = likely ? s.likelyYes : s.likelyNo;
  const arr = arrivalAt(state, driveLeft);
  const img = imagingFrom(state, driveLeft, config.doorToImaging.p25);
  $('imagingLine').textContent = `${s.arrivalLine(Math.round(arr))}. ${s.imagingLine(Math.round(img))}.`
    + (exp != null && shown === 'pending' && exp <= img ? ` ${s.resultBeforeImaging}.` : '');
  const win = decisionWindow(state, driveLeft, config.doorToImaging.p25);
  if (shown !== 'pending' && state.t < img) {
    $('windowLine').innerHTML = `<b>${Math.round(img - state.t)} min</b> ${esc(s.windowLeft)}`;
  } else if (win != null && shown === 'pending') {
    $('windowLine').innerHTML = win >= 0 ? `<b>${Math.round(win)} min</b> ${esc(s.windowPending)}` : esc(s.windowAfter(Math.round(-win)));
  }
  if (d.fpKey) $('fpLine').textContent = s[d.fpKey];

  // alternatives: always show the other options, so the detour question stays visible
  const lines = [];
  const links = [link('target', h, kind)];
  for (const key of ['ns', 'both', 'su']) {
    const opt = d.options[key];
    if (key === d.target || !opt || opt.idx === tgt.idx) continue;
    if (key === 'su' && d.target === 'su') continue;
    if (lines.some((l) => l.idx === opt.idx)) continue;
    lines.push({ idx: opt.idx, html: optionLine(key, opt, d) });
    links.push(link('alt', ui.hospitals[opt.idx], siteKind(ui.hospitals, opt.idx)));
  }
  $('altBlock').innerHTML = lines.map((l) => l.html).join('');
  setLinks(links);
}

// ---------- clock ----------
let last = null;
function tick(ts) {
  if (ui.playing) {
    if (last != null) {
      state.t = Math.min(MAX_MIN, state.t + ((ts - last) / 60000) * ui.rate);
      if (state.t >= MAX_MIN) setPlaying(false);
      update();
    }
    last = ts;
  } else {
    last = null;
  }
  requestAnimationFrame(tick);
}

function setPlaying(on) {
  ui.playing = on;
  $('playBtn').setAttribute('aria-pressed', String(on));
  $('playBtn').textContent = on ? L().pause : L().play;
}

// ---------- events ----------
function bind() {
  $('startBtn').addEventListener('click', () => { state.testStart = state.t; state.resultAt = null; update(); });
  $('leaveBtn').addEventListener('click', () => { state.leaveAt = state.t; update(); });
  $('resetBtn').addEventListener('click', () => {
    Object.assign(state, initial(), { k: state.k, result: state.result });
    setPlaying(false);
    update();
  });
  $('playBtn').addEventListener('click', () => setPlaying(!ui.playing));
  $('rateSeg').addEventListener('click', (e) => {
    const r = Number(e.target.dataset.rate);
    if (!r) return;
    ui.rate = r;
    buildRates();
  });
  $('scrub').max = MAX_MIN;
  $('scrub').addEventListener('input', (e) => { state.t = Number(e.target.value); update(); });
  $('resultAt').addEventListener('change', (e) => {
    const v = e.target.value === '' ? null : Number(e.target.value);
    state.resultAt = v != null && state.testStart != null ? Math.max(v, state.testStart) : null;
    update();
  });
  $('resultSeg').addEventListener('change', (e) => { state.result = e.target.value; update(); });
  $('speedSeg').addEventListener('change', (e) => { state.k = Number(e.target.value); update(); });
  $('langBtn').addEventListener('click', () => {
    ui.lang = ui.lang === 'en' ? 'de' : 'en';
    store.set('sim-lang', ui.lang);
    applyStatic();
    update();
  });
  $('aboutBtn').addEventListener('click', () => $('aboutDlg').showModal());
  bindSheet();
}

// Phone bottom sheet: drag the handle up or down; it snaps to small, half or full height. A tap toggles half/full.
const SNAPS = [0.16, 0.38, 0.85];
function setSheet(px, animate) {
  const panel = $('panel');
  panel.style.transition = animate ? '' : 'none';
  panel.style.maxHeight = `${px}px`;
  const open = px > window.innerHeight * 0.5;
  panel.classList.toggle('open', open);
  $('sheetHandle').setAttribute('aria-expanded', String(open));
  if (!animate && ui.map) ui.map.setPadding({ top: 0, left: 0, right: 0, bottom: px });
}
function bindSheet() {
  const h = $('sheetHandle');
  let startY = null, startH = 0, moved = false;
  h.addEventListener('pointerdown', (e) => {
    startY = e.clientY; startH = $('panel').offsetHeight; moved = false;
    h.setPointerCapture(e.pointerId);
  });
  h.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    if (moved) setSheet(Math.min(window.innerHeight * 0.9, Math.max(60, startH + dy)), false);
  });
  const end = () => {
    if (startY == null) return;
    startY = null;
    const vh = window.innerHeight, cur = $('panel').offsetHeight;
    const target = moved
      ? SNAPS.map((s) => s * vh).reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a))
      : (cur > vh * 0.5 ? SNAPS[1] : SNAPS[2]) * vh;
    setSheet(target, true);
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
}

async function main() {
  applyStatic();
  buildRates();
  bind();
  ui.hospitals = await (await fetch('data/hospitals.json')).json();
  ui.grid = await loadGrid('data');
  initMap();
  update();
  requestAnimationFrame(tick);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app works without offline cache */ });
  }
}

main();

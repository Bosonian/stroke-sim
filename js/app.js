// Stroke routing simulator: map, draggable ambulance, blood-draw timing and what a positive result changes.
// Logic lives in story.js / decide.js / national.js (tested); this file wires it to the page.
/* global maplibregl */
import { config } from '../config.js';
import { strings } from './i18n.js';
import { loadGrid } from './grid.js';
import { hospitalFeatures, siteKind } from './hospitals.js';
import { range } from './decide.js';
import { fetchLive, fetchRoute, routeLabel } from './route.js';
import { resultMinute, splitRoute, story } from './story.js';
import { nationalPixels, DRAW_COLORS, LATE_GREY } from './national.js';

const KIND_COLOR = { su: '#0072B2', ns: '#CC79A7', both: '#009E73' };
const LINE = { drive: '#33475B', via: '#7A8899', direct: '#CC79A7' };
const BASE_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const FALLBACK_STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#E9EDF1' } }],
};
const KM_LAT = 1 / 111.2; // degrees latitude per km
const NAT_BOX = { west: 5.5, east: 15.5, south: 47.0, north: 55.2 };
const NAT_COORDS = [[NAT_BOX.west, NAT_BOX.north], [NAT_BOX.east, NAT_BOX.north], [NAT_BOX.east, NAT_BOX.south], [NAT_BOX.west, NAT_BOX.south]];
const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = { s: config.drawDefault, result: config.resultDefault, k: config.kDefault };
const ui = {
  lang: store.get('sim-lang') === 'de' ? 'de' : 'en',
  pos: { ...config.start },
  grid: null,
  hospitals: [],
  map: null,
  marker: null,
  resultMarker: null,
  snap: null, // phone sheet: index into SNAPS once the user has moved it
  moveTo: null, // set by initMap: (lon, lat, pan) => void
  live: null, // { key, data } road routes for the position `key`
  natKey: null, // s|k of the national image on the map
};
const EX = config.excludedSites;
const posKey = () => `${ui.pos.lon.toFixed(4)},${ui.pos.lat.toFixed(4)}`;
const liveCache = new Map();
const branchCache = new Map(); // result point -> neurosurgery road routes
let liveTimer = null;

/** Ask for road routes once the ambulance has stopped moving; the grid answers meanwhile. */
function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    const key = posKey();
    let data = liveCache.get(key);
    if (data === undefined) {
      const { lon, lat } = ui.pos;
      data = await fetchLive(lon, lat, ui.hospitals, ui.grid ? ui.grid.lookup(lon, lat) : null, config);
      if (data) {
        if (liveCache.size > 300) liveCache.clear();
        liveCache.set(key, data);
      }
    }
    if (key !== posKey()) return; // moved on meanwhile
    ui.live = data ? { key, data } : null;
    update();
  }, config.routing.debounceMs);
}

/** Road route from the result point to neurosurgery; undefined while loading, null if it failed. */
function branchRoute(p, nsIdx) {
  const key = `${p[0].toFixed(4)},${p[1].toFixed(4)}|${nsIdx}`;
  if (branchCache.has(key)) return branchCache.get(key);
  branchCache.set(key, undefined);
  const h = ui.hospitals[nsIdx];
  fetchRoute(p, [h.lon, h.lat], config).then((r) => {
    if (branchCache.size > 300) branchCache.clear();
    branchCache.set(key, r);
    update();
  });
  return undefined;
}

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
  buildSegment('drawSeg', 'draw', config.draws, (v) => s.draws[v], state.s);
  buildSegment('resultSeg', 'result', config.results, (v) => s.results[v], state.result);
  buildSegment('speedSeg', 'speed', config.kValues, (v) => s.speeds[v], state.k);
  const dot = (c) => `<i style="background:${c}"></i>`;
  const bar = (c, dash) => `<i class="bar${dash ? ' dash' : ''}" style="--c:${c}"></i>`;
  $('legend').innerHTML = [
    ...['su', 'ns', 'both'].map((k) => `<li>${dot(KIND_COLOR[k])}${esc(s.legend[k])}</li>`),
    `<li>${bar(LINE.via, true)}${esc(s.lines.via)}</li>`,
    `<li>${bar(LINE.direct)}${esc(s.lines.direct)}</li>`,
    `<li><i class="tube-dot"></i>${esc(s.resultMarker)}</li>`,
  ].join('');
  $('natTitle').textContent = s.national.title;
  $('natList').innerHTML = [15, 10, 5, 0].map((v) => `<li>${dot(DRAW_COLORS[v])}${esc(s.national[v])}</li>`).join('')
    + `<li>${dot(LATE_GREY)}${esc(s.national.late)}</li>`;
  $('aboutBody').innerHTML = [...s.aboutBody, s.stayNote(config.stay), config.stay.source, config.stay.context, s.routingAbout,
    s.imagingNote(config.doorToImaging), s.combinedUnavailable, s.gapNote,
    `${s.excludedLabel} ${Object.values(EX).map((v) => v.split(':')[0]).join('; ')}.`, config.model.source]
    .map((p) => `<p>${esc(p)}</p>`).join('');
  $('placeSel').innerHTML = `<option value="">–</option>`
    + config.places.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  if (ui.marker) ui.marker.getElement().setAttribute('aria-label', s.ambulanceLabel);
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

// ---------- map ----------
function ambulanceEl() {
  const el = document.createElement('div');
  el.className = 'ambulance';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', L().ambulanceLabel);
  el.innerHTML = `<svg viewBox="0 0 46 46" aria-hidden="true">
    <rect x="14" y="4" width="18" height="38" rx="4" fill="#ffffff" stroke="#13273F" stroke-width="1.5"/>
    <rect x="14" y="22" width="18" height="5" fill="#F2342B"/>
    <rect x="16" y="9" width="14" height="3" rx="1.5" fill="#2F7DE1"/>
    <rect x="17" y="30" width="12" height="9" rx="1.5" fill="none" stroke="#F2342B" stroke-width="1.6"/>
    <path d="M23 31.5v6M20 34.5h6" stroke="#F2342B" stroke-width="1.6"/>
  </svg>`;
  return el;
}

function resultEl() {
  const el = document.createElement('div');
  el.className = 'result-marker';
  el.innerHTML = `<span class="tube" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v11.5a2 2 0 0 0 4 0V3" fill="none" stroke="#18222F" stroke-width="1.8" stroke-linecap="round"/><path d="M10 10h4v4.5a2 2 0 0 1-4 0z" fill="#C2312A"/></svg></span><span class="result-label"></span>`;
  return el;
}

/** Paint the national view for the chosen blood draw and speed (skipped when nothing changed). */
function renderNational() {
  const src = ui.map && ui.map.getSource('national');
  const key = `${state.s}|${state.k}`;
  if (!src || !ui.grid || ui.natKey === key) return;
  ui.natKey = key;
  const width = 640;
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const height = Math.round((width * (mercY(NAT_BOX.north) - mercY(NAT_BOX.south))) / (((NAT_BOX.east - NAT_BOX.west) * Math.PI) / 180));
  const px = nationalPixels(ui.grid, { ...NAT_BOX, width, height, k: state.k, s: state.s, A: config.A });
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  cv.getContext('2d').putImageData(new ImageData(px, width, height), 0, 0);
  src.updateImage({ url: cv.toDataURL(), coordinates: NAT_COORDS });
}

function showNatLegend() {
  const on = !!ui.map && !!ui.grid && ui.map.getZoom() < config.nationalMaxZoom;
  $('natLegend').hidden = !on;
}

function addLayers(map) {
  if (map.getSource('hospitals')) return;
  map.addSource('national', { type: 'image', url: BLANK, coordinates: NAT_COORDS });
  map.addLayer({
    id: 'national', type: 'raster', source: 'national', maxzoom: config.nationalMaxZoom,
    paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
  });
  ui.natKey = null;
  map.addSource('links', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('hospitals', { type: 'geojson', data: hospitalFeatures(ui.hospitals, EX) });
  map.addLayer({
    id: 'links-via', type: 'line', source: 'links', filter: ['==', ['get', 'role'], 'via'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': LINE.via, 'line-width': 3, 'line-dasharray': [1.5, 1.5] },
  });
  map.addLayer({
    id: 'links-drive', type: 'line', source: 'links', filter: ['==', ['get', 'role'], 'drive'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': LINE.drive, 'line-width': 4.5 },
  });
  map.addLayer({
    id: 'links-direct', type: 'line', source: 'links', filter: ['==', ['get', 'role'], 'direct'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': LINE.direct, 'line-width': 6.5 },
  });
  map.addLayer({
    id: 'links-label', type: 'symbol', source: 'links', filter: ['!=', ['get', 'label'], ''],
    layout: {
      'symbol-placement': 'line-center', 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'],
      'text-size': ['case', ['==', ['get', 'role'], 'direct'], 15, 13], 'text-allow-overlap': true,
    },
    paint: { 'text-color': '#18222F', 'text-halo-color': '#ffffff', 'text-halo-width': 2.4 },
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
  padMap();
  map.jumpTo({ center: [ui.pos.lon, ui.pos.lat] });
  window.addEventListener('resize', onResize);
  $('panel').addEventListener('transitionend', () => { padMap(); map.easeTo({ center: [ui.pos.lon, ui.pos.lat], duration: 300 }); });

  let fellBack = false;
  const fallback = () => {
    if (fellBack) return;
    fellBack = true;
    map.setStyle(FALLBACK_STYLE);
  };
  map.on('error', () => { if (!map.isStyleLoaded()) fallback(); });
  setTimeout(() => { if (!map.isStyleLoaded()) fallback(); }, 8000);
  map.on('style.load', () => { addLayers(map); update(); });
  map.on('zoom', showNatLegend);
  map.on('click', 'hospitals', hospitalPopup);
  map.on('mouseenter', 'hospitals', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'hospitals', () => { map.getCanvas().style.cursor = ''; });

  ui.resultMarker = new maplibregl.Marker({ element: resultEl(), anchor: 'bottom' });
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
    scheduleLive();
  };
  // tap or click anywhere on the map moves the ambulance there (taps on a hospital open its details instead)
  map.on('click', (e) => {
    if (map.getLayer('hospitals') && map.queryRenderedFeatures(e.point, { layers: ['hospitals'] }).length) return;
    ui.marker.setLngLat(e.lngLat);
    follow();
  });
  ui.marker.on('drag', follow);
  ui.marker.on('dragend', follow);
  ui.moveTo = (lon, lat, pan) => {
    ui.marker.setLngLat([lon, lat]);
    follow();
    if (pan) map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 8), duration: 600 });
  };
  // keyboard: arrow keys move the ambulance 1 km (Shift: 10 km)
  ui.marker.getElement().addEventListener('keydown', (e) => {
    const step = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (!step) return;
    e.preventDefault();
    const km = e.shiftKey ? 10 : 1;
    const dLat = step[1] * km * KM_LAT;
    const dLon = (step[0] * km * KM_LAT) / Math.cos((ui.pos.lat * Math.PI) / 180);
    ui.moveTo(ui.pos.lon + dLon, ui.pos.lat + dLat, true);
  });
}

// ---------- the map story and the card ----------
function setLinks(features) {
  const src = ui.map && ui.map.getSource('links');
  if (src) src.setData({ type: 'FeatureCollection', features });
}

const line = (role, coords, label = '') => ({ type: 'Feature', properties: { role, label }, geometry: { type: 'LineString', coordinates: coords } });
const ll = (h) => [h.lon, h.lat];
const kmText = (opt) => (opt.km != null && opt.geom ? `, ${opt.km < 10 ? opt.km.toFixed(1) : Math.round(opt.km)} km` : '');

function optionLine(label, opt) {
  const h = ui.hospitals[opt.idx];
  const r = range(opt.t, config.kValues, state.k);
  return `<span>${esc(label)}: <b>${esc(h.name)}</b>, ${r.mid} min (${r.lo}–${r.hi})${kmText(opt)}</span>`;
}

function setBadge(main, sub) {
  $('badge').hidden = !main;
  $('badgeMain').textContent = main || '';
  $('badgeSub').textContent = sub || '';
  $('badgeSub').hidden = !sub;
}

function clearStory(notice) {
  setBadge('', '');
  setLinks([]);
  if (ui.resultMarker) ui.resultMarker.remove();
  $('decisionLine').textContent = '';
  $('targetName').textContent = '';
  $('savingLine').textContent = '';
  $('timingLine').textContent = '';
  $('altBlock').innerHTML = '';
  $('noticeLine').textContent = notice;
}

function update() {
  const s = L();
  renderNational();
  showNatLegend();
  $('shareLine').textContent = state.k === config.shares.k
    ? `${s.shareLine(config.shares.values[state.s])} ${s.shareNote}` : '';
  const tier = config.tiers[state.result];
  $('decision').dataset.tier = state.result;
  $('tierLine').textContent = state.result === 'below' ? s.tierBelow : `ICH ${s.results[state.result]}`;
  $('fpLine').textContent = tier.positive ? s[state.result === 't71' ? 'fp71' : 'fpHigher'](config.model.ppv) : '';
  $('stayLine').textContent = `${s.stayNote(config.stay)} ${config.stay.source}. ${config.stay.context}`;
  $('combinedLine').textContent = tier.positive && !config.combinedRoutes ? s.combinedUnavailable : '';

  // live road routes for this exact position if we have them; otherwise the 1 km grid
  const live = ui.live && ui.live.key === posKey() ? ui.live.data : null;
  const look = live || (ui.grid ? ui.grid.lookup(ui.pos.lon, ui.pos.lat) : null);
  $('estimateNote').textContent = live ? s.routeNoteLive : `${s.estimateNote} ${s.connectorNote}`;
  if (!look) return clearStory(!ui.grid ? `${s.noData} ${s.dragHint}` : s.noRoad);
  if (!live && EX[ui.hospitals[look.ns.idx].id]) return clearStory(s.liveNeeded);
  $('noticeLine').textContent = '';

  const su = ui.hospitals[look.su.idx];
  const ns = ui.hospitals[look.ns.idx];
  const same = look.ns.idx === look.su.idx || ns.su_partner === su.id;
  const origin = [ui.pos.lon, ui.pos.lat];
  const resultMin = resultMinute(state.s, config.A);

  // where the result arrives: on the road to the stroke unit, resultMin minutes after leaving (drive time / k)
  const suCoords = live && live.su.geom ? [origin, ...live.su.geom] : [origin, ll(su)];
  const suSeg = live && live.su.geom && live.su.segDur ? [0, ...live.su.segDur] : null;
  const split = splitRoute(suCoords, suSeg, (resultMin * 60) / state.k, look.su.t * 60);

  let branch = null; // road route result point -> neurosurgery (k = 1)
  if (live && !same && resultMin === 0 && live.ns.geom) branch = { sec: live.ns.sec, m: live.ns.m, geom: [origin, ...live.ns.geom] };
  else if (live && !same && resultMin > 0 && split.after.length > 1) {
    const r = branchRoute(split.point, look.ns.idx);
    if (r) branch = { ...r, geom: [split.point, ...r.geom] };
  }
  const st = story({
    s: state.s, A: config.A, k: state.k, tier: state.result, look, same, stay: config.stay.median,
    suNsMin: live ? (live.suNs ? live.suNs.sec / 60 : same ? 0 : null) : null,
    pNsMin: branch ? branch.sec / 60 : null,
  });

  // map lines
  const suLabel = live && live.su.geom ? routeLabel(live.su.sec, live.su.m, state.k) : '';
  const transfer = !same ? line('via', live && live.suNs ? [ll(su), ...live.suNs.geom] : [ll(su), ll(ns)],
    live && live.suNs ? routeLabel(live.suNs.sec, live.suNs.m, state.k) : '') : null;
  const feats = [];
  if (st.mode === 'turn') {
    if (split.before.length > 1) feats.push(line('drive', split.before));
    feats.push(line('via', split.after, suLabel));
    if (transfer) feats.push(transfer);
    feats.push(line('direct', branch ? branch.geom : [split.point, ll(ns)], branch ? routeLabel(branch.sec, branch.m, state.k) : ''));
  } else {
    feats.push(line('drive', suCoords, suLabel));
    if (st.mode === 'late' && transfer) feats.push(transfer);
  }
  setLinks(feats);

  // the test tube: where the result arrives (at the stroke unit, with "+N min", when it comes too late)
  const late = st.lead < 0;
  const at = late ? suCoords[suCoords.length - 1] : split.point;
  if (ui.resultMarker && ui.map) {
    const el = ui.resultMarker.getElement();
    el.querySelector('.result-label').textContent = s.results[state.result] + (late ? ` · +${Math.ceil(-st.lead)} min` : '');
    el.setAttribute('aria-label', s.resultMarker);
    el.title = s.resultMarker;
    ui.resultMarker.setLngLat(at).addTo(ui.map);
  }

  // badge on the map and the three card lines
  let main, sub;
  if (st.mode === 'turn' && st.savingMin != null) {
    main = s.badgeTurn(Math.round(st.savingMin));
    sub = s.badgeTurnSub({ withMin: Math.round(st.withMin), driveWithout: Math.round(st.withoutMin - config.stay.median), stay: config.stay.median });
  } else if (st.mode === 'turn') {
    main = s.badgeTurnOffline;
    sub = live ? '' : s.badgeTurnOfflineSub;
  } else if (st.mode === 'late') {
    main = s.badgeLate(Math.ceil(st.lateMin));
    sub = s.badgeLateSub;
  } else if (st.mode === 'same') {
    main = s.badgeSame; sub = s.badgeSameSub;
  } else {
    main = s.badgeBelow; sub = s.badgeBelowSub;
  }
  setBadge(main, sub);
  const target = st.mode === 'turn' ? ns : su;
  $('decisionLine').textContent = st.mode === 'turn' ? s.decisionTurn : st.mode === 'same' ? s.decisionSame : s.decisionSu;
  $('targetName').textContent = `${target.name}, ${target.city}`;
  $('savingLine').textContent = main;
  $('timingLine').textContent = `${s.resultReady(Math.round(resultMin))}. ${late ? s.afterLine(Math.ceil(-st.lead)) : s.leadLine(Math.round(st.lead))}`;
  $('altBlock').innerHTML = optionLine(s.target.su, look.su) + (same ? '' : optionLine(s.target.ns, look.ns));
}

// ---------- events ----------
function bind() {
  $('drawSeg').addEventListener('change', (e) => { state.s = Number(e.target.value); update(); });
  $('resultSeg').addEventListener('change', (e) => { state.result = e.target.value; update(); });
  $('speedSeg').addEventListener('change', (e) => { state.k = Number(e.target.value); update(); });
  $('langBtn').addEventListener('click', () => {
    ui.lang = ui.lang === 'en' ? 'de' : 'en';
    store.set('sim-lang', ui.lang);
    applyStatic();
    update();
  });
  $('aboutBtn').addEventListener('click', () => $('aboutDlg').showModal());
  $('evidenceBtn').addEventListener('click', () => $('aboutDlg').showModal());
  $('placeSel').addEventListener('change', (e) => {
    const p = config.places[Number(e.target.value)];
    if (p && ui.moveTo) ui.moveTo(p.lon, p.lat, true);
  });
  bindSheet();
}

// Phone bottom sheet: drag the handle up or down; it snaps to small, half or full height. A tap toggles half/full.
const SNAPS = [0.16, 0.38, 0.85];
const isPhone = () => window.matchMedia('(max-width: 899px)').matches;
function padMap() {
  if (!ui.map) return;
  ui.map.setPadding({ top: 0, left: 0, right: 0, bottom: isPhone() ? $('panel').offsetHeight : 0 });
}
function setSheet(px, animate) {
  const panel = $('panel');
  panel.style.transition = animate ? '' : 'none';
  panel.style.maxHeight = `${px}px`;
  const open = px > window.innerHeight * 0.5;
  panel.classList.toggle('open', open);
  $('sheetHandle').setAttribute('aria-expanded', String(open));
  // set padding now too: with reduced motion there is no transitionend event
  if (ui.map) ui.map.setPadding({ top: 0, left: 0, right: 0, bottom: Math.min(px, panel.scrollHeight) });
}
function snapTo(i) {
  if (!isPhone()) return; // the handle exists only in the phone layout
  ui.snap = i;
  setSheet(SNAPS[i] * window.innerHeight, true);
}
function onResize() {
  const panel = $('panel');
  if (!isPhone()) {
    panel.style.maxHeight = '';
    panel.style.transition = '';
    panel.classList.remove('open');
    ui.snap = null;
  } else if (ui.snap != null) {
    setSheet(SNAPS[ui.snap] * window.innerHeight, false);
  }
  padMap();
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
  const toggle = () => snapTo($('panel').offsetHeight > window.innerHeight * 0.5 ? 1 : 2);
  const end = () => {
    if (startY == null) return;
    startY = null;
    const vh = window.innerHeight, cur = $('panel').offsetHeight;
    if (!moved) return toggle();
    const dist = SNAPS.map((s) => Math.abs(s * vh - cur));
    snapTo(dist.indexOf(Math.min(...dist)));
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  // keyboard (Enter/Space) produces a click with detail 0; pointer taps are handled above
  h.addEventListener('click', (e) => { if (e.detail === 0) toggle(); });
}

async function main() {
  applyStatic();
  bind();
  try {
    if (typeof maplibregl === 'undefined') throw new Error('map library not loaded');
    const r = await fetch('data/hospitals.json');
    if (!r.ok) throw new Error(`hospitals: HTTP ${r.status}`);
    ui.hospitals = await r.json();
    ui.grid = await loadGrid('data');
    initMap();
  } catch (err) {
    console.error(err);
    $('noticeLine').textContent = L().loadError;
    return;
  }
  update();
  scheduleLive();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app works without offline cache */ });
  }
}

main();

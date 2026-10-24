// Stroke routing simulator: map, draggable ambulance, blood-draw timing and what a positive result changes.
// Logic lives in story.js / decide.js / national.js (tested); this file wires it to the page.
/* global maplibregl */
import { config, waitMin } from '../config.js?v=26'; // versioned with app.js in index.html, so a new page never links old settings
import { strings, startLang } from './i18n.js?v=26';
import { loadGrid } from './grid.js?v=26';
import { hospitalFeatures, siteKind } from './hospitals.js?v=26';
import { range } from './decide.js?v=26';
import { fetchLive, fetchRoute, routeLabel } from './route.js?v=26';
import { leadTime, midpoint, remainder, resultMinute, splitRoute, story, withTestRoute } from './story.js?v=26';
import { matchPresets, reversePlace, searchPlaces } from './search.js?v=26';
import { centredBox, minuteOfDay, laneLaps, latestLaps, laps, wallTime, phaseAt, raceSchedule, positionAt, clockSegments, minuteAt, totalSeconds, raceBlocker, summaryTable, diffText, COMPARED, doorWatches, doorChip } from './race.js?v=26';
import { nationalPixels, DRAW_COLORS, LATE_GREY } from './national.js?v=26';
import { ROAD_COLORS, styleRoads } from './roads.js?v=26';
import { START_TIERS, canStart, startDecision, needsZoom } from './start.js?v=26';

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

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; }
}

const state = { s: config.drawDefault, result: config.resultDefault, k: config.kDefault };
const ui = {
  lang: startLang(store.get('sim-lang'), deviceTimeZone()),
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
  raceIn: null, // inputs for a race at the current position, or null when it cannot run
  race: null, // the running or finished race
};
const EX = config.excludedSites;
const posKey = () => `${ui.pos.lon.toFixed(4)},${ui.pos.lat.toFixed(4)}`;
const liveCache = new Map();
const branchCache = new Map(); // result point -> neurosurgery road routes
let liveTimer = null;

/** Ask for road routes once the ambulance has stopped moving; the grid answers meanwhile. */
function scheduleLive() {
  clearTimeout(liveTimer);
  ui.livePending = true;
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
    ui.livePending = false;
    if (!ui.race) update(); // never interrupt a race; the next change redraws from the cache
  }, config.routing.debounceMs);
}

/** Road route from the result point to neurosurgery, leaving in the ambulance's heading;
 *  undefined while loading, null if it failed. */
function branchRoute(p, nsIdx, heading) {
  const key = `${p[0].toFixed(4)},${p[1].toFixed(4)}|${nsIdx}|${heading == null ? '' : Math.round(heading)}`;
  if (branchCache.has(key)) return branchCache.get(key);
  branchCache.set(key, undefined);
  const h = ui.hospitals[nsIdx];
  fetchRoute(p, [h.lon, h.lat], config, fetch, heading).then((r) => {
    if (branchCache.size > 300) branchCache.clear();
    branchCache.set(key, r);
    if (!ui.race) update(); // a late answer (also for an earlier setting) must not stop a race
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
    `<li><b class="chip-key">${esc(s.chipBp)}</b>${esc(s.raceLegend.bp)}</li>`,
    `<li><b class="chip-key">${esc(s.chipReversal)}</b>${esc(s.raceLegend.reversal)}</li>`,
    ...[['autobahn', 'autobahnCase'], ['bundes', 'bundesCase'], ['land', 'landCase']].map(([k, e]) =>
      `<li><i class="road-key" style="--c:${ROAD_COLORS[k]};--e:${ROAD_COLORS[e]}"></i>${esc(s.roadKey[k])}</li>`),
  ].join('');
  $('natTitle').textContent = s.national.title;
  $('natList').innerHTML = [15, 10, 5, 0].map((v) => `<li>${dot(DRAW_COLORS[v])}${esc(s.national[v])}</li>`).join('')
    + `<li>${dot(LATE_GREY)}${esc(s.national.late)}</li>`;
  $('aboutBody').innerHTML = [...s.aboutBody, s.stayNote(config.stay), config.stay.source, config.stay.context, s.routingAbout, s.terrainNote, s.searchAbout,
    s.imagingNote(config.doorToImaging), s.combinedUnavailable, s.gapNote,
    `${s.excludedLabel} ${Object.values(EX).map((v) => v.split(':')[0]).join('; ')}.`, config.model.source]
    .map((p) => `<p>${esc(p)}</p>`).join('');
  $('placeInput').placeholder = s.searchPlaceholder;
  if (ui.startSel) buildStart();
  $('placeList').setAttribute('aria-label', s.searchLabel);
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
  const map = ui.map;
  const key = `${state.s}|${state.k}`;
  if (!map || !map.getLayer('links-via') || !ui.grid || ui.natKey === key) return;
  ui.natKey = key;
  const width = 640;
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const height = Math.round((width * (mercY(NAT_BOX.north) - mercY(NAT_BOX.south))) / (((NAT_BOX.east - NAT_BOX.west) * Math.PI) / 180));
  const px = nationalPixels(ui.grid, { ...NAT_BOX, width, height, k: state.k, s: state.s, A: config.A });
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  cv.getContext('2d').putImageData(new ImageData(px, width, height), 0, 0);
  const url = cv.toDataURL();
  const src = map.getSource('national');
  if (src) {
    src.updateImage({ url, coordinates: NAT_COORDS });
    return;
  }
  // added with its real image: replacing a placeholder while it loads raises an AbortError
  map.addSource('national', { type: 'image', url, coordinates: NAT_COORDS });
  map.addLayer({
    id: 'national', type: 'raster', source: 'national', maxzoom: config.nationalMaxZoom,
    paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
  }, 'links-via');
}

function showNatLegend() {
  const on = !!ui.map && !!ui.grid && ui.map.getZoom() < config.nationalMaxZoom;
  $('natLegend').hidden = !on;
}

function addLayers(map) {
  if (map.getSource('hospitals')) return;
  ui.natKey = null; // the national image is added by renderNational once it is painted
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
  // the race: trails drawn behind the two dots
  map.addSource('race', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const raceLine = (role, paint, dash) => map.addLayer({
    id: `race-${role}`, type: 'line', source: 'race', filter: ['==', ['get', 'role'], role],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: dash ? { ...paint, 'line-dasharray': dash } : paint,
  });
  raceLine('without', { 'line-color': LINE.via, 'line-width': 3 }, [1.5, 1.5]);
  raceLine('plan', { 'line-color': LINE.direct, 'line-width': 6.5, 'line-opacity': 0.35 });
  raceLine('shared', { 'line-color': LINE.drive, 'line-width': 4.5 });
  raceLine('branch', { 'line-color': LINE.direct, 'line-width': 6.5 });
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

  // plain background only if the base style itself never loads; later errors (a tile, an aborted image) are ignored
  let styleReady = false;
  let fellBack = false;
  const fallback = () => {
    if (fellBack || styleReady) return;
    fellBack = true;
    map.setStyle(FALLBACK_STYLE, { diff: false });
  };
  map.on('error', (e) => { if (!(e && e.error && e.error.name === 'AbortError')) fallback(); });
  setTimeout(fallback, 8000);
  map.on('style.load', () => { styleReady = true; addLayers(map); styleRoads(map, config.terrain); if (!ui.race) update(); });
  map.on('zoom', showNatLegend);
  map.on('zoomend', placeLabels);
  map.on('zoom', setPickZoom);
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
    if (ui.picking) finishPick();
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
  ui.links = features.filter((f) => f.properties.label);
  placeLabels();
}

/** "min · km" pills in the colour of their route: on the route half way along, or, when the route is too short
 *  on screen (it would sit under the ambulance or the test tube), beside the hospital it leads to. */
function placeLabels() {
  (ui.labelMarks || []).forEach((m) => m.remove());
  ui.labelMarks = [];
  if (!ui.map || !ui.links) return;
  const atEnd = new Map(); // pills beside the same hospital are stacked
  const placed = []; // screen points of pills on routes: one that would cover another moves down a row
  for (const f of ui.links) {
    const c = f.geometry.coordinates;
    const a = ui.map.project(c[0]);
    const b = ui.map.project(c[c.length - 1]);
    const el = document.createElement('div');
    el.className = `route-pill ${f.properties.role}`;
    el.style.setProperty('--c', LINE[f.properties.role] || LINE.drive);
    el.textContent = f.properties.label;
    let m;
    if (Math.hypot(a.x - b.x, a.y - b.y) < 90) {
      const key = `${Math.round(b.x)},${Math.round(b.y)}`;
      const n = atEnd.get(key) || 0;
      atEnd.set(key, n + 1);
      m = new maplibregl.Marker({ element: el, anchor: 'left', offset: [12, n * 24] }).setLngLat(c[c.length - 1]);
    } else {
      const mid = midpoint(c);
      const p = ui.map.project(mid);
      let dy = 0;
      while (placed.some((q) => Math.abs(q.x - p.x) < 170 && Math.abs(q.y - (p.y + dy)) < 24)) dy += 26;
      placed.push({ x: p.x, y: p.y + dy });
      m = new maplibregl.Marker({ element: el, offset: [0, dy] }).setLngLat(mid);
    }
    ui.labelMarks.push(m.addTo(ui.map));
  }
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
  ui.raceIn = null;
  setPlay('offline');
}

function update() {
  stopRace();
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
  let branchState = null; // the same for the race: undefined while loading, null if missing
  const inTime = leadTime(state.s, look.su.t * state.k, config.A) >= 0;
  if (live && !same && resultMin === 0) {
    if (live.ns.geom) branch = { sec: live.ns.sec, m: live.ns.m, geom: [origin, ...live.ns.geom], segDur: live.ns.segDur ? [0, ...live.ns.segDur] : null };
    branchState = branch;
  } else if (live && !same && resultMin > 0 && inTime) {
    // also when the result arrives exactly at the door (L = 0): the re-route then starts there
    branchState = branchRoute(split.point, look.ns.idx, split.heading);
    if (branchState) branch = { ...branchState, geom: [split.point, ...branchState.geom], segDur: branchState.segDur ? [0, ...branchState.segDur] : null };
  }
  const st = story({
    s: state.s, A: config.A, k: state.k, tier: state.result, look, same, stay: waitMin(config.stay),
    suNsMin: live ? (live.suNs ? live.suNs.sec / 60 : same ? 0 : null) : null,
    pNsMin: branch ? branch.sec / 60 : null,
  });

  // map lines
  // one label per route, for the whole route: to the stroke unit, the transfer, and (with the test) to neurosurgery
  const P = L().pill;
  const suLabel = live && live.su.geom ? routeLabel(live.su.sec, live.su.m, state.k, same ? P.ns : P.su) : '';
  const transfer = !same ? line('via', live && live.suNs ? [ll(su), ...live.suNs.geom] : [ll(su), ll(ns)],
    live && live.suNs ? routeLabel(live.suNs.sec, live.suNs.m, state.k, P.transfer) : '') : null;
  let nsLabel = '';
  if (branch) {
    const resultSec = (resultMin * 60) / state.k;
    const rest = live.su.geom ? remainder(suCoords, suSeg, live.su.sec, live.su.m, resultSec) : { m: live.su.m };
    const all = withTestRoute(live.su, rest, branch, resultSec);
    nsLabel = routeLabel(all.sec, all.m, state.k, P.ns);
  }
  const feats = [];
  if (st.mode === 'turn') {
    if (split.before.length > 1) feats.push(line('drive', split.before));
    feats.push(line('via', split.after, suLabel));
    if (transfer) feats.push(transfer);
    feats.push(line('direct', branch ? branch.geom : [split.point, ll(ns)], nsLabel));
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
    main = s.badgeTurn(st.savingWhole);
    sub = s.badgeTurnSub({ withMin: Math.round(st.withMin), driveWithout: Math.round(st.withoutMin - waitMin(config.stay)), stay: waitMin(config.stay) });
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
  prepareRace({ live, look, st, su, ns, same, origin, suCoords, suSeg, branch, branchState });
  const target = st.mode === 'turn' ? ns : su;
  $('decisionLine').textContent = st.mode === 'turn' ? s.decisionTurn : st.mode === 'same' ? s.decisionSame : s.decisionSu;
  $('targetName').textContent = `${target.name}, ${target.city}`;
  $('savingLine').textContent = main;
  $('timingLine').textContent = `${s.resultReady(Math.round(resultMin))}. ${late ? s.afterLine(Math.ceil(-st.lead)) : s.leadLine(Math.round(st.lead))}`;
  $('altBlock').innerHTML = optionLine(s.target.su, look.su) + (same ? '' : optionLine(s.target.ns, look.ns));
}

// ---------- place search ----------
const search = { items: [], active: -1, ctl: null, timer: null, view: null };

/** The list under the search box: example places, then search results, then a status line. */
function renderSearch() {
  const s = L();
  const v = search.view;
  const input = $('placeInput');
  search.items = [...v.local, ...v.remote];
  const opt = (p, i) => `<li role="option" id="placeOpt${i}" class="opt${i === search.active ? ' active' : ''}" data-i="${i}" aria-selected="${i === search.active}">`
    + `<b>${esc(p.label)}</b>${p.sub ? `<small>${esc(p.sub)}</small>` : ''}</li>`;
  const head = (text) => `<li role="presentation" class="opt-head">${esc(text)}</li>`;
  const msg = { searching: s.searching, failed: s.searchOffline, none: s.searchNone }[v.state] || '';
  const html = (v.local.length ? head(s.searchExamples) + v.local.map((p, i) => opt(p, i)).join('') : '')
    + (v.remote.length ? head(s.searchResults) + v.remote.map((p, j) => opt(p, v.local.length + j)).join('') : '')
    + (msg ? `<li role="presentation" class="opt-note">${esc(msg)}</li>` : '');
  $('placeList').innerHTML = html;
  $('placeList').hidden = !html;
  input.setAttribute('aria-expanded', String(!!html));
  if (search.active >= 0) input.setAttribute('aria-activedescendant', `placeOpt${search.active}`);
  else input.removeAttribute('aria-activedescendant');
  $('placeStatus').textContent = msg;
  const act = document.getElementById(`placeOpt${search.active}`);
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}

function closeSearch() {
  $('placeList').hidden = true;
  $('placeInput').setAttribute('aria-expanded', 'false');
  $('placeInput').removeAttribute('aria-activedescendant');
}

/** Example places at once; online results after a short pause in typing (an older search is cancelled). */
function onSearchInput() {
  const q = $('placeInput').value;
  clearTimeout(search.timer);
  if (search.ctl) search.ctl.abort();
  const online = q.trim().length >= config.search.minChars;
  search.active = -1;
  search.view = { local: matchPresets(q, config.places), remote: [], state: online ? 'searching' : 'idle' };
  renderSearch();
  if (!online) return;
  search.timer = setTimeout(async () => {
    const ctl = new AbortController();
    search.ctl = ctl;
    try {
      const r = await searchPlaces(q, { fetchFn: fetch, lang: ui.lang, places: config.places, cfg: config.search, signal: ctl.signal });
      if (search.ctl !== ctl) return;
      search.view = { local: r.local, remote: r.remote, state: r.failed ? 'failed' : r.local.length + r.remote.length ? 'idle' : 'none' };
      renderSearch();
    } catch (e) { /* cancelled by a newer search */ }
  }, config.search.debounceMs);
}

function choosePlace(i) {
  const p = search.items[i];
  if (!p) return;
  clearTimeout(search.timer);
  if (search.ctl) search.ctl.abort();
  search.ctl = null;
  const input = $('placeInput');
  input.value = p.label;
  closeSearch();
  if (input.blur) input.blur(); // presenter keys work again
  if (isPhone() && !$('startDlg').open) snapTo(1); // show the map again
  if (ui.moveTo) ui.moveTo(p.lon, p.lat, true);
  if ($('startDlg').open) { ui.startSel.placed = true; refreshStart(); }
}

function bindSearch() {
  const input = $('placeInput');
  input.addEventListener('focus', () => {
    if (isPhone() && !$('startDlg').open) snapTo(2); // room for the list on phones
    onSearchInput();
  });
  input.addEventListener('input', onSearchInput);
  input.addEventListener('blur', () => setTimeout(closeSearch, 150));
  input.addEventListener('keydown', (e) => {
    const n = search.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!n) return;
      search.active = e.key === 'ArrowDown' ? Math.min(search.active + 1, n - 1) : Math.max(search.active - 1, 0);
      renderSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (n) choosePlace(search.active >= 0 ? search.active : 0);
    } else if (e.key === 'Escape') {
      if ($('placeList').hidden) input.value = '';
      closeSearch();
    }
  });
  // mousedown, not click: it comes before the box loses focus
  $('placeList').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const li = e.target.closest && e.target.closest('[data-i]');
    if (li) choosePlace(Number(li.dataset.i));
  });
}

// ---------- the race ----------
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const EMPTY = { type: 'FeatureCollection', features: [] };

/** Inputs for a race at this position (road routes only), and the Play button's state. */
function prepareRace({ live, look, st, su, ns, same, origin, suCoords, suSeg, branch, branchState }) {
  ui.raceIn = null;
  const blocker = raceBlocker({ live, mode: st.mode, branch: st.mode === 'turn' ? branchState : null, transfer: !!(live && live.suNs && live.suNs.geom) });
  if (!blocker) {
    const routes = { su: { coords: suCoords, segDur: suSeg, sec: live.su.sec } };
    if (branch) routes.branch = { coords: branch.geom, segDur: branch.segDur, sec: branch.sec };
    if (live.suNs && !same) {
      routes.transfer = { coords: [ll(su), ...live.suNs.geom], segDur: live.suNs.segDur ? [0, ...live.suNs.segDur] : null, sec: live.suNs.sec };
    }
    ui.raceIn = {
      args: {
        s: state.s, A: config.A, k: state.k, tier: state.result, mode: st.mode, tSu: look.su.t,
        suNs: routes.transfer ? live.suNs.sec / 60 : null, nsDirect: look.ns.t, pNs: branch ? branch.sec / 60 : null,
        scan: waitMin(config.doorToImaging), stay: waitMin(config.stay),
      },
      routes, origin, su: ll(su), ns: ll(ns),
    };
  }
  setPlay(blocker);
  if (ui.startPending) checkStart(blocker);
}

/** Play / Skip / Replay label; with a blocker (or null) also whether the race can run. */
function setPlay(blocker) {
  const b = $('playBtn');
  const s = L();
  if (blocker !== undefined) {
    b.disabled = !!blocker;
    b.title = blocker ? s.playBlocked[blocker] : '';
  }
  b.textContent = ui.race ? (ui.race.done ? s.replay : s.skip) : s.play;
  $('raceBarPlay').textContent = b.textContent; // the phone race bar mirrors it
  $('raceBarPlay').disabled = b.disabled;
}

function dotEl(kind) {
  const el = document.createElement('div');
  el.className = `race-dot ${kind}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', kind === 'red' ? L().raceWith : L().raceWithout);
  // the test ring fills over the test's 15 minutes
  if (kind === 'red') el.innerHTML = '<svg class="ring" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg>';
  return el;
}

function chip(text, cls, at, anchor, offset) {
  const el = document.createElement('div');
  el.className = `race-chip ${cls}`;
  el.textContent = text;
  const m = new maplibregl.Marker({ element: el, anchor, offset }).setLngLat(at).addTo(ui.map);
  ui.race.marks.push(m);
  return m;
}

function startRace() {
  const inp = ui.raceIn;
  if (!inp || !ui.map) return;
  stopRace();
  const sched = raceSchedule(inp.args);
  const seg = clockSegments(sched);
  const r = { inp, sched, seg, total: totalSeconds(seg), t0: performance.now(), raf: 0, marks: [], fired: new Set(), done: false, plan: false, watches: doorWatches(sched).map((w) => ({ ...w, chip: null })) };
  r.clock = { ...config.clock, startMin: minuteOfDay(new Date()) }; // the assessment starts now (each Replay too)
  r.laps = laps(sched, config.clock.assessMin);
  r.lanes = { with: laneLaps(r.laps, 'with'), without: laneLaps(r.laps, 'without') };
  r.lapKey = '';
  r.flash = {};
  ui.race = r;
  document.body.classList.add('racing');
  padMap(); // on phones the card steps aside during the race
  setLinks([]);
  $('lapBox').hidden = false;
  ui.resultMarker.remove();
  $('badge').hidden = true;
  ui.marker.getElement().style.visibility = 'hidden';
  r.grey = new maplibregl.Marker({ element: dotEl('grey') }).setLngLat(inp.origin).addTo(ui.map);
  r.red = new maplibregl.Marker({ element: dotEl('red') }).setLngLat(inp.origin).addTo(ui.map);
  $('raceClock').hidden = false;
  buildLanes();
  r.bounds = new maplibregl.LngLatBounds(inp.origin, inp.origin);
  Object.values(inp.routes).forEach((rt) => rt.coords.forEach((c) => r.bounds.extend(c)));
  // keep the routes clear of the clock (top) and the lanes (bottom; hidden on phones while racing)
  if (isPhone()) {
    fitRace(phoneFit()); // now, and again once the clock lines are written (they set its height)
    requestAnimationFrame(() => requestAnimationFrame(() => { if (ui.race === r) fitRace(phoneFit()); }));
  } else { // desktop: the scene stays in the middle of the free map, all routes in view
    const pts = Object.values(inp.routes).flatMap((rt) => rt.coords);
    const side = $('raceSide');
    fitRace({ top: 40, bottom: $('raceLanes').offsetHeight + 48 + 40, left: side.offsetLeft + side.offsetWidth + 24 }, centredBox(pts, inp.origin));
  }
  if (reduceMotion()) r.t0 -= r.total * 1000;
  setPlay();
  r.raf = requestAnimationFrame(raceFrame);
}

/** Phone race view: the free map between the clock (top) and the lap timers and bar (bottom). */
function phoneFit() {
  const clock = $('raceClock');
  return { top: (clock.offsetTop || 0) + clock.offsetHeight + 14, bottom: $('lapBox').offsetHeight + $('raceBar').offsetHeight + 34 };
}

function fitRace({ top, bottom, left = 60, right = 60 }, bounds = ui.race.bounds) {
  ui.map.fitBounds(bounds, { padding: { top, bottom, left, right }, maxZoom: 13, duration: reduceMotion() ? 0 : 700 });
}

function skipRace() {
  if (ui.race && !ui.race.done) ui.race.t0 = performance.now() - ui.race.total * 1000;
}

/** Back to the static view (the caller redraws it). */
function stopRace() {
  const r = ui.race;
  if (!r) return;
  cancelAnimationFrame(r.raf);
  r.red.remove();
  r.grey.remove();
  r.marks.forEach((m) => m.remove());
  const src = ui.map && ui.map.getSource('race');
  if (src) src.setData(EMPTY);
  document.body.classList.remove('racing');
  padMap();
  $('raceClock').hidden = true;
  $('lapBox').hidden = true;
  $('lapWith').innerHTML = '';
  $('lapWithout').innerHTML = '';
  $('raceLanes').hidden = true;
  $('raceLanes').innerHTML = '';
  $('raceLanes').classList.remove('summary');
  document.body.classList.remove('race-summary');
  ui.marker.getElement().style.visibility = '';
  ui.race = null;
  setPlay();
}

function raceFrame() {
  const r = ui.race;
  if (!r) return;
  const sec = Math.min(r.total, (performance.now() - r.t0) / 1000);
  if (sec >= r.total) r.done = true; // the lap list then drops its "now" line
  drawRace(r.done ? r.sched.end : minuteAt(r.seg, sec)); // the last frame exactly at the end (no rounding short of it)
  if (r.done) {
    setPlay();
    showSummary();
    return;
  }
  r.raf = requestAnimationFrame(raceFrame);
}

/** Everything on the map at model minute `min`. */
function drawRace(min) {
  const r = ui.race;
  const { sched, inp } = r;
  const { k, s: draw, A } = inp.args;
  const s = L();
  const at = (lane, m) => positionAt(sched[lane].legs, m, k, inp.routes);
  r.red.setLngLat(at('with', min));
  r.grey.setLngLat(at('without', min));
  const ring = r.red.getElement().querySelector('.ring circle');
  if (ring) ring.setAttribute('stroke-dashoffset', String(100 * (1 - Math.max(0, Math.min(1, (min + draw) / A)))));
  for (const lane of ['with', 'without']) {
    for (const e of sched[lane].events) {
      const id = `${lane}:${e.key}`;
      if (min < e.min || r.fired.has(id)) continue;
      r.fired.add(id);
      raceEvent(lane, e, at(lane, e.min));
    }
  }
  // door-to-image clocks: the chip fills while the scan is awaited
  r.watches.filter((w) => w.chip).forEach((w) => {
    const el = w.chip.getElement();
    el.textContent = doorChip(min, w, s);
    el.classList.toggle('dti', min < w.scan);
    el.style.setProperty('--p', `${Math.round(100 * Math.max(0, Math.min(1, (min - w.arrive) / (w.scan - w.arrive || 1))))}%`);
  });
  setRaceTrails(min);
  updateLanes(min);
  const now = wallTime(min, draw, r.clock);
  $('clockMain').textContent = now;
  const g = r.seg.find((x) => min >= x.min0 && min <= x.min1) || r.seg[r.seg.length - 1];
  const speed = g && g.rate > 2 ? s.speedFast : s.speedNormal;
  const rel = min < -0.5 ? s.beforeDeparture : min < 0.5 ? s.clockDepart : s.clockAt(Math.floor(min));
  $('clockSpeed').textContent = `${rel} · ${speed}`;
  drawLaps(min, now);
  drawHeadline(min);
}

/** Text of one milestone ("BP lowering starts"), with "in the ambulance" unless `place` is false. */
function lapText(l, place = true) {
  const s = L();
  const key = l.key === 'su' && ui.race.sched.same ? 'suNs' : l.key; // one hospital with both
  const text = key === 'result' ? s.lap.result(s.results[ui.race.inp.args.tier]) : s.lap[key];
  return place && l.inAmbulance ? `${text} ${s.lap.inAmbulance}` : text;
}

/** Two lap timers, one per dot: the milestones reached by minute `min` with their clock times, and a running "now" line. */
function drawLaps(min, now) {
  const r = ui.race;
  const s = L();
  const done = (l) => l.min <= min + 1e-9;
  const key = `${r.laps.filter(done).length}|${now}|${ui.lang}|${r.done}`;
  if (key === r.lapKey) return;
  r.lapKey = key;
  const item = (l) => `<li><time>${wallTime(l.min, r.inp.args.s, r.clock)}</time><span>${esc(lapText(l, false))}`
    + `${l.inAmbulance ? ` <b class="amb">${esc(s.lap.inAmbulance)}</b>` : ''}</span></li>`;
  const nowLine = r.done ? '' : `<li class="now"><time>${now}</time><span>${esc(s.lap.now)}</span></li>`;
  $('lapWith').innerHTML = r.lanes.with.filter(done).map(item).join('') + nowLine;
  $('lapWithout').innerHTML = r.lanes.without.filter(done).map(item).join('') + nowLine;
  const box = $('lapBox');
  if (box.scrollTo) box.scrollTo({ top: box.scrollHeight });
}

/** Live heading, one line per dot: a new milestone shows for a moment with its clock time, then the ongoing
 *  phase "since" that time, so the heading and the lap timers tell the same story. */
function drawHeadline(min) {
  const r = ui.race;
  const s = L();
  const t = (m) => wallTime(m, r.inp.args.s, r.clock);
  for (const [lane, id] of [['with', 'phaseWith'], ['without', 'phaseWithout']]) {
    const group = latestLaps(r.lanes[lane], min);
    const at = group.length ? group[0].min : null;
    const f = r.flash[lane];
    if (!f || f.at !== at) r.flash[lane] = { at, until: f ? performance.now() + 2500 : 0 }; // no flash for the opening state
    const flashing = !r.done && at !== null && performance.now() < r.flash[lane].until;
    const text = flashing ? `${t(at)} ${group.map(lapText).join(' · ')}`
      : `${s.phase[phaseAt(r.sched[lane], min)]}${at !== null ? ` · ${s.since(t(at))}` : ''}`;
    const el = $(id);
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('event', flashing);
  }
}

function raceEvent(lane, e, pos) {
  const r = ui.race;
  const s = L();
  const { mode, tier } = r.inp.args;
  const red = r.red.getElement();
  if (lane === 'with' && e.key === 'result') {
    const suAt = r.sched.without.events.find((x) => x.key === 'su').min;
    const late = mode === 'late';
    ui.resultMarker.getElement().querySelector('.result-label').textContent = s.results[tier] + (late ? ` · +${Math.max(1, Math.ceil(e.min - suAt))} min` : '');
    ui.resultMarker.setLngLat(pos).addTo(ui.map);
    const ring = red.querySelector('.ring');
    if (ring) ring.remove();
    red.classList.add('flash'); // one burst when the result arrives
    if (mode === 'below') red.classList.add('faded');
    if (late) red.classList.add('still');
    if (mode === 'turn') {
      r.plan = true;
      const c = chip(s.reroute, 'route', pos, 'bottom', [0, -48]);
      setTimeout(() => c.remove(), 1500);
    }
  } else if (e.key === 'bp' || e.key === 'reversal') {
    const text = `${e.key === 'bp' ? s.chipBp : s.chipReversal}${e.afterScan ? ` · ${s.chipAfterScan}` : ''}`;
    const row = e.key === 'bp' ? 0 : 26;
    if (lane === 'with') chip(text, 'treat', pos, 'right', [-16, 18 + row]); // below the result tag
    else chip(text, 'treat grey', pos, 'bottom-left', [14, -10 - row]); // above right, clear of the door-to-image chip below
  } else {
    // arrival at a hospital: its door-to-image clock starts
    const w = r.watches.find((x) => x.lane === lane && x.arrive === e.min && (e.key === 'su' || e.key === 'ns'));
    if (w && !w.chip) w.chip = chip(doorChip(e.min, w, s), 'clock dti', pos, 'top', [0, 18]);
  }
}

/** Two thin lanes under the map, filled up to the clock: drive, wait at the stroke unit, treatment marks. */
function buildLanes() {
  const r = ui.race;
  const s = L();
  const { sched } = r;
  const span = sched.end - sched.start || 1;
  const pct = (m) => `${(((m - sched.start) / span) * 100).toFixed(2)}%`;
  const width = (a, b) => `${(((b - a) / span) * 100).toFixed(2)}%`;
  const lane = (key) => {
    const ln = sched[key];
    const segs = ln.legs.map((l) => ({ a: l.from, b: l.to, cls: key === 'with' && l.route === 'branch' ? 'branch' : 'drive' }));
    const su = ln.events.find((e) => e.key === 'su');
    const leaves = ln.events.find((e) => e.key === 'transferLeaves');
    if (su) segs.push({ a: su.min, b: leaves ? leaves.min : sched.end, cls: 'wait' });
    // door to image: from arrival at the first hospital to the scan
    const door = su || ln.events.find((e) => e.key === 'ns');
    const scanEv = ln.events.find((e) => e.key === 'scan');
    if (door && scanEv) segs.push({ a: door.min, b: scanEv.min, cls: 'dti' });
    if (key === 'with') segs.push({ a: sched.start, b: ln.events.find((e) => e.key === 'result').min, cls: 'test' });
    const marks = ln.events.filter((e) => ['bp', 'reversal', 'ns'].includes(e.key))
      .map((e) => `<i class="mark${key === 'without' ? ' grey' : ''}" data-min="${e.min}" style="left:${pct(e.min)}"></i>`);
    return `<div class="lane" data-lane="${key}"><span class="lane-name">${esc(key === 'with' ? s.laneWith : s.laneWithout)}</span>`
      + `<div class="track">${segs.filter((g) => g.b > g.a).map((g) => `<i class="seg ${g.cls}" style="left:${pct(g.a)};width:${width(g.a, g.b)}"></i>`).join('')}`
      + `<i class="cover"></i>${marks.join('')}<i class="head"></i></div></div>`;
  };
  $('raceLanes').innerHTML = lane('with') + lane('without');
  $('raceLanes').hidden = false;
  r.pct = pct;
}

function updateLanes(min) {
  const r = ui.race;
  const box = $('raceLanes');
  box.querySelectorAll('.cover').forEach((el) => { el.style.left = r.pct(min); });
  box.querySelectorAll('.head').forEach((el) => { el.style.left = r.pct(min); });
  box.querySelectorAll('.mark').forEach((el) => el.classList.toggle('on', min >= Number(el.dataset.min)));
}

/** At the end: the time points of both lanes, the intervals between them and the differences. */
/** The waits of the lane without the test, each a collapsible "i" with what it means and its study. */
function explainers(s, r) {
  const cite = (c) => `<p class="cite"><span>${esc(s.explain.source)}</span> ${esc(c.authors)} ${esc(c.title)} <i>${esc(c.journal)}</i>. ${esc(c.ref)}. `
    + `<a href="https://doi.org/${c.doi}" target="_blank" rel="noopener">doi:${c.doi}</a></p>`;
  const item = (x, n, data) => `<details class="explain"><summary><b class="i" aria-hidden="true">i</b>${esc(x.title(n))}</summary>`
    + `<p>${esc(x.body(data))}</p>${cite(data.cite)}</details>`;
  const transfer = r.sched.without.events.some((e) => e.key === 'transferLeaves');
  return item(s.explain.scan, r.inp.args.scan, config.doorToImaging)
    + (transfer ? item(s.explain.stay, r.inp.args.stay, config.stay) : '');
}

function showSummary() {
  const r = ui.race;
  const s = L();
  const { mode } = r.inp.args;
  const rows = summaryTable(r.sched);
  const fmt = (m) => wallTime(m, r.inp.args.s, r.clock);
  const WHERE = { ambulance: s.inAmbulance, beforeScan: s.beforeScan, afterScan: s.chipAfterScan };
  const cell = (c) => {
    if (!c) return '<td class="none">—</td>';
    const gap = c.gap ? s.gap[c.gap.kind](c.gap.min) : '';
    const note = c.place ? [s.milestone[c.place], gap].filter(Boolean).join(' · ') : c.where ? WHERE[c.where] : gap;
    return `<td><b>${fmt(c.min)}</b>${note ? `<small>${esc(note)}</small>` : ''}</td>`;
  };
  const diffCell = (d) => (d == null ? '<td></td>' : `<td class="diff${d > 0 ? ' good' : d < 0 ? ' bad' : ''}">${esc(diffText(d, s))}</td>`);
  const head = `<tr><th></th><th class="with"><span class="lane-name">${esc(s.laneWith)}</span></th>`
    + `<th><span class="lane-name">${esc(s.laneWithout)}</span></th><th>${esc(s.colDiff)}</th></tr>`;
  // the timeline first, then (after a rule) the compared rows
  const firstCompared = rows.find((row) => COMPARED.includes(row.key));
  const body = rows.map((row) => `<tr class="${COMPARED.includes(row.key) ? 'key' : ''}${row === firstCompared ? ' sep' : ''}"><th scope="row">${esc(s.row[row.key])}</th>`
    + `${cell(row.with)}${cell(row.without)}${diffCell(row.diff)}</tr>`).join('');
  const note = s.endNote({ scan: r.inp.args.scan, stay: r.inp.args.stay, transfer: r.sched.without.events.some((e) => e.key === 'transferLeaves') });
  $('raceLanes').innerHTML = `<p class="sum-title">${esc(s.tableTitle(wallTime(r.sched.start - config.clock.assessMin, r.inp.args.s, r.clock)))}</p><table class="sum-table"><thead>${head}</thead><tbody>${body}</tbody></table>`
    + (mode === 'below' ? '' : `<p class="sum-note">${esc(note)}</p>${explainers(s, r)}`);
  $('raceLanes').classList.add('summary');
  document.body.classList.add('race-summary');
  $('raceClock').hidden = true;
  // the badge carries the one headline; the table has the details (on phones the table replaces the badge)
  const d = (key) => rows.find((row) => row.key === key)?.diff;
  const headline = d('ns') != null && (mode === 'turn' || d('bp') == null) ? s.endNs(diffText(d('ns'), s))
    : d('bp') != null ? s.endBp(diffText(d('bp'), s)) : null;
  if (mode === 'below') setBadge(s.badgeBelow, s.badgeBelowSub);
  else setBadge(headline || s.badgeSame, '');
  const lanes = $('raceLanes');
  const badge = $('badge');
  if (isPhone()) { // headline on top, table at the bottom: the map in between
    const h = (lanes.offsetParent && lanes.offsetParent.clientHeight) || window.innerHeight;
    fitRace({ top: (badge.offsetTop || 0) + badge.offsetHeight + 16, bottom: h - (lanes.offsetTop || 0) + 16 });
  }
  else fitRace({ top: badge.offsetTop + badge.offsetHeight + 20, bottom: lanes.offsetHeight + 48 + 30 });
}

/** Roads driven so far (and, after a re-route, the new route ahead). */
function setRaceTrails(min) {
  const r = ui.race;
  const src = ui.map.getSource('race');
  if (!src) return;
  const { routes, args } = r.inp;
  const line2 = (role, coords) => ({ type: 'Feature', properties: { role }, geometry: { type: 'LineString', coordinates: coords } });
  const driven = (lane, roleOf) => lane.legs.filter((l) => min > l.from).map((l) => {
    const rt = routes[l.route];
    const m = Math.min(min, l.to);
    return line2(roleOf(l), splitRoute(rt.coords, rt.segDur, ((m - l.from) * 60) / args.k, rt.sec).before);
  });
  const feats = [];
  if (r.plan) feats.push(line2('without', routes.su.coords), line2('plan', routes.branch.coords));
  feats.push(...driven(r.sched.without, () => 'without'));
  feats.push(...driven(r.sched.with, (l) => (l.route === 'branch' ? 'branch' : 'shared')));
  src.setData({ type: 'FeatureCollection', features: feats.filter((f) => f.geometry.coordinates.length > 1) });
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
  $('playBtn').addEventListener('click', () => {
    if (ui.race && !ui.race.done) return skipRace();
    return startRace();
  });
  // presenter keys: Space = play / skip, 1-4 = blood-draw time (not while typing or on a button)
  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY', 'A'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (ui.picking && e.key === 'Escape') return endPick();
    if ($('aboutDlg').open || $('startDlg').open || ui.picking) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!$('playBtn').disabled) $('playBtn').click();
      return;
    }
    const i = ['1', '2', '3', '4'].indexOf(e.key);
    if (i < 0) return;
    state.s = config.draws[i];
    buildSegment('drawSeg', 'draw', config.draws, (v) => L().draws[v], state.s);
    update();
  });
  bindSearch();
  bindSheet();
  bindStart();
}

// ---------- the start box ----------
/** Tier cards and blood-draw times in the box, in the current language, keeping the choices made. */
function buildStart() {
  const s = L();
  const sel = ui.startSel;
  const color = { t71: 'var(--tier-71)', t81: 'var(--tier-81)', t91: 'var(--tier-91)' };
  $('startTierCards').innerHTML = START_TIERS.map((t) => `<label class="tier-card" style="--c:${color[t]}">`
    + `<input type="radio" name="startTier" value="${t}"${sel.tier === t ? ' checked' : ''}>`
    + `<b>${esc(s.results[t])}</b><small>${esc(s.startTiers[t])}</small></label>`).join('');
  buildSegment('startDraw', 'startDraw', config.draws, (v) => s.draws[v], sel.draw);
  refreshStart();
}

function refreshStart(status) {
  const ready = canStart(ui.startSel, config.draws);
  $('startGoBtn').disabled = !ready || !!ui.startPending;
  $('startStatus').textContent = status !== undefined ? status : ready ? '' : L().startMissing;
}

function openStart() {
  if ($('startDlg').open) return;
  $('startPlace').appendChild($('placeSearch')); // the same search box, lent to the start box
  buildStart();
  $('startDlg').showModal();
}

function closeStart() {
  $('drawSeg').parentNode.insertBefore($('placeSearch'), $('drawSeg'));
  closeSearch();
  $('startDlg').close();
}

/** Start: take the choices, then wait for the road routes; the race begins when they are there. */
function onStart() {
  const sel = ui.startSel;
  if (!canStart(sel, config.draws)) return;
  state.result = sel.tier;
  state.s = sel.draw;
  buildSegment('drawSeg', 'draw', config.draws, (v) => L().draws[v], state.s);
  buildSegment('resultSeg', 'result', config.results, (v) => L().results[v], state.result);
  stopRace();
  ui.startPending = true;
  refreshStart(L().startWaiting);
  update();
}

function checkStart(blocker) {
  const d = startDecision({ livePending: !!ui.livePending, blocker });
  if (d === 'wait') return;
  ui.startPending = false;
  if (d === 'blocked') return refreshStart(L().playBlocked[blocker]);
  closeStart();
  setTimeout(startRace, 0); // after this redraw
}

/** "Choose on the map": the box steps aside, one click on the map places the ambulance, the box comes back. */
function startPick() {
  closeSearch();
  $('startDlg').close();
  ui.picking = true;
  document.body.classList.add('picking');
  $('pickBar').hidden = false;
  padMap();
  setPickZoom();
}

/** While choosing on the map: "zoom in" until street level. */
function setPickZoom() {
  if (ui.picking) $('pickZoom').hidden = !needsZoom(ui.map.getZoom(), config.pickZoom);
}

function endPick() {
  ui.picking = false;
  document.body.classList.remove('picking');
  $('pickBar').hidden = true;
  padMap();
  $('startDlg').showModal();
}

async function finishPick() {
  const { lon, lat } = ui.pos;
  ui.startSel.placed = true;
  const input = $('placeInput');
  input.value = L().pickedPoint;
  endPick();
  refreshStart();
  const name = await reversePlace(lon, lat, { fetchFn: fetch, lang: ui.lang, cfg: config.search });
  if (name && ui.pos.lon === lon && ui.pos.lat === lat) input.value = name; // not moved again meanwhile
}

function bindStart() {
  ui.startSel = { placed: false, tier: null, draw: null };
  $('startTier').addEventListener('change', (e) => { ui.startSel.tier = e.target.value; refreshStart(); });
  $('startDraw').addEventListener('change', (e) => { ui.startSel.draw = Number(e.target.value); refreshStart(); });
  $('startGoBtn').addEventListener('click', onStart);
  $('startLangBtn').addEventListener('click', () => $('langBtn').click());
  $('startDlg').addEventListener('cancel', (e) => e.preventDefault()); // the map opens with Start only
  $('pickMapBtn').addEventListener('click', startPick);
  $('raceBarPlay').addEventListener('click', () => $('playBtn').click());
  $('raceBarEnd').addEventListener('click', () => { stopRace(); update(); });
  $('pickBack').addEventListener('click', endPick);
  $('newSimBtn').addEventListener('click', () => {
    stopRace();
    update();
    openStart();
  });
}

// Phone bottom sheet: drag the handle up or down; it snaps to small, half or full height. A tap toggles half/full.
const SNAPS = [0.16, 0.38, 0.85];
const isPhone = () => window.matchMedia('(max-width: 899px)').matches;
function padMap() {
  if (!ui.map) return;
  const aside = ['racing', 'picking'].some((c) => document.body.classList.contains(c)); // phones: the card is hidden then
  ui.map.setPadding({ top: 0, left: 0, right: 0, bottom: isPhone() && !aside ? $('panel').offsetHeight : 0 });
}
function setSheet(px, animate) {
  const panel = $('panel');
  panel.style.transition = animate ? '' : 'none';
  panel.style.maxHeight = `${px}px`;
  if (document.documentElement.style) document.documentElement.style.setProperty('--sheet-h', `${px}px`); // lap box sits above the sheet
  const open = px > window.innerHeight * 0.5;
  panel.classList.toggle('open', open);
  $('sheetHandle').setAttribute('aria-expanded', String(open));
  // set padding now too: with reduced motion there is no transitionend event
  if (ui.map && !document.body.classList.contains('racing')) ui.map.setPadding({ top: 0, left: 0, right: 0, bottom: Math.min(px, panel.scrollHeight) });
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
  openStart(); // the map opens with Start
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app works without offline cache */ });
  }
}

main();

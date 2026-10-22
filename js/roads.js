// Base map additions: roads in the colours of German road signs (Autobahn blue, Bundesstraße yellow, Landstraße
// white), their numbers on matching shields, and hill shading. Visual only: drive times come from OSRM, which
// weighs road types but not slopes. Road colours follow the OpenStreetMap class (trunk and primary ≈ Bundesstraße).

export const ROAD_COLORS = {
  autobahn: '#3A72B8', autobahnCase: '#23518C', autobahnTunnel: '#9DB8DC', autobahnFar: 'rgba(58, 114, 184, 0.55)',
  bundes: '#F2C230', bundesCase: '#B98E14', land: '#ffffff', landCase: '#A9B3BE', landFar: '#C3CAD2',
};

const C = ROAD_COLORS;
const isBundes = (yes, no) => ['match', ['get', 'class'], ['trunk', 'primary'], yes, no];
const PAINT = [
  ['highway_motorway_inner', 'line-color', C.autobahn],
  ['highway_motorway_bridge_inner', 'line-color', C.autobahn],
  ['highway_motorway_casing', 'line-color', C.autobahnCase],
  ['tunnel_motorway_inner', 'line-color', C.autobahnTunnel],
  ['highway_motorway_subtle', 'line-color', C.autobahnFar],
  ['highway_major_inner', 'line-color', isBundes(C.bundes, C.land)],
  ['highway_major_casing', 'line-color', isBundes(C.bundesCase, C.landCase)],
  ['highway_major_subtle', 'line-color', isBundes(C.bundes, C.landFar)],
  ['highway_major_subtle', 'line-width', isBundes(2.4, 1.4)],
];

/** Rounded box, `border` round `fill` ([r, g, b]), as image data for map.addImage (drawn at pixel ratio 2). */
export function shieldImage(fill, border, width = 40, height = 28, radius = 7, line = 3) {
  const data = new Uint8Array(width * height * 4);
  const inside = (x, y, inset) => {
    const r = radius - inset;
    const dx = Math.max(inset + radius - x, 0, x - (width - inset - radius));
    const dy = Math.max(inset + radius - y, 0, y - (height - inset - radius));
    return x >= inset && x <= width - inset && y >= inset && y <= height - inset && dx * dx + dy * dy <= r * r;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x + 0.5, y + 0.5, 0)) continue;
      const c = inside(x + 0.5, y + 0.5, line) ? fill : border;
      data.set([...c, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

// first part of "A 3;E 56"
const REF = ['let', 'r', ['get', 'ref'], ['let', 'i', ['index-of', ';', ['var', 'r']],
  ['case', ['>=', ['var', 'i'], 0], ['slice', ['var', 'r'], 0, ['var', 'i']], ['var', 'r']]]];
const IS_A = ['==', ['slice', ['get', 'ref'], 0, 2], 'A '];

/** Adds the road colours, shields and hill shading to a loaded style; safe to call again and on the plain fallback map. */
export function styleRoads(map, terrain) {
  for (const [id, prop, value] of PAINT) if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
  if (map.getLayer('highway-shield-non-us')) map.setLayoutProperty('highway-shield-non-us', 'visibility', 'none');
  const before = map.getLayer('links-via') ? 'links-via' : undefined;

  if (map.getSource('openmaptiles') && !map.getLayer('road-shields')) {
    const fit = { pixelRatio: 2, stretchX: [[8, 32]], stretchY: [[8, 20]], content: [6, 4, 34, 24] };
    if (!map.hasImage('shield-a')) map.addImage('shield-a', shieldImage([58, 114, 184], [255, 255, 255]), fit);
    if (!map.hasImage('shield-b')) map.addImage('shield-b', shieldImage([242, 194, 48], [27, 36, 48]), fit);
    map.addLayer({
      id: 'road-shields', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', minzoom: 7.5,
      filter: ['all', ['has', 'ref'], ['match', ['slice', ['get', 'ref'], 0, 2], ['A ', 'B '], true, false]],
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': 320,
        'text-rotation-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
        'icon-image': ['case', IS_A, 'shield-a', 'shield-b'], 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 3, 1, 3],
        'text-field': REF, 'text-font': ['Noto Sans Bold'], 'text-size': 11,
      },
      paint: { 'text-color': ['case', IS_A, '#ffffff', '#1B2430'] },
    }, before);
  }

  if (!map.getSource('terrain')) {
    map.addSource('terrain', {
      type: 'raster-dem', tiles: [terrain.url], encoding: 'terrarium', tileSize: 256, maxzoom: terrain.maxzoom,
      attribution: terrain.attribution,
    });
  }
  if (!map.getLayer('hillshade')) {
    // under roads and place names, over land and water
    const layers = map.getStyle().layers;
    const road = layers.find((l) => /^(tunnel|highway|road|bridge|railway|aeroway)/.test(l.id));
    const firstSymbol = layers.find((l) => l.type === 'symbol');
    map.addLayer({
      id: 'hillshade', type: 'hillshade', source: 'terrain',
      paint: {
        'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 5, 0.25, 9, 0.4, 12, 0.5],
        'hillshade-shadow-color': '#5B6B7C', 'hillshade-highlight-color': 'rgba(255, 255, 255, 0.6)',
        'hillshade-accent-color': '#8896A5',
      },
    }, (road || firstSymbol || {}).id || before);
  }
}

// Hospital layer: a neurosurgery site with a stroke unit at the same hospital is drawn once, as "both".

/** 'su' | 'ns' | 'both' for the hospital with this index. */
// excluded: { dest_id: reason } (config.excludedSites); excluded sites are neither drawn nor routed to.
export function siteKind(hospitals, idx, excluded = {}) {
  const h = hospitals[idx];
  if (h.is_ns) return h.su_partner ? 'both' : 'ns';
  return hospitals.some((x) => x.su_partner === h.id && !excluded[x.id]) ? 'both' : 'su';
}

export function hospitalFeatures(hospitals, excluded = {}) {
  const features = hospitals
    .filter((h) => !excluded[h.id] && !(h.is_ns && h.su_partner))
    .map((h) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
      properties: { idx: h.idx, id: h.id, name: h.name, city: h.city, kind: siteKind(hospitals, h.idx, excluded) },
    }));
  return { type: 'FeatureCollection', features };
}

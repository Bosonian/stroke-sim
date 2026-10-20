// EPSG:3035 (ETRS89 / LAEA Europe): ellipsoidal Lambert azimuthal equal-area, forward only.
// Formulas: IOGP Guidance Note 7-2, method EPSG 9820. Used to find the 1 km grid square under a map position.

const A = 6378137.0;
const F = 1 / 298.257222101; // GRS80
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const LAT0 = (52 * Math.PI) / 180;
const LON0 = (10 * Math.PI) / 180;
const FE = 4321000;
const FN = 3210000;

const q = (phi) => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
const QP = q(Math.PI / 2);
const RQ = A * Math.sqrt(QP / 2);
const BETA0 = Math.asin(q(LAT0) / QP);
const D = (A * Math.cos(LAT0)) / Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2) / (RQ * Math.cos(BETA0));

/** [easting, northing] in metres for a longitude/latitude in degrees. */
export function toLaea(lon, lat) {
  const beta = Math.asin(q((lat * Math.PI) / 180) / QP);
  const dl = (lon * Math.PI) / 180 - LON0;
  const B = RQ * Math.sqrt(2 / (1 + Math.sin(BETA0) * Math.sin(beta) + Math.cos(BETA0) * Math.cos(beta) * Math.cos(dl)));
  return [
    FE + B * D * Math.cos(beta) * Math.sin(dl),
    FN + (B / D) * (Math.cos(BETA0) * Math.sin(beta) - Math.sin(BETA0) * Math.cos(beta) * Math.cos(dl)),
  ];
}

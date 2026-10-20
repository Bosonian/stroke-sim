// Simulator settings in one place (design section 7.1). Change cut-offs, test time or model figures here only.
export const config = {
  A: 15, // minutes from starting the test to the result (assumed whole-blood workflow)
  kValues: [0.8, 1.0, 1.3], // driving-time factor: blue light, normal car speed, slow
  kDefault: 1.0,
  bothMaxExtraMin: 10, // prefer the hospital with neurosurgery AND stroke unit if at most this much further
  combinedRoutes: false, // true only once routes to the nearest combined centre are built (design 8.1); until then
  //                        the drive-time grid holds only the nearest stroke unit and nearest neurosurgery site
  maxMin: 120, // end of the timeline; the result-at input has the same limit
  results: ['pending', 'below', 't71', 't81', 't91'],
  tiers: {
    pending: { positive: false, actions: [] },
    below: { positive: false, actions: ['standard'] },
    t71: { positive: true, actions: ['ns'] },
    t81: { positive: true, actions: ['ns', 'bp'] },
    t91: { positive: true, actions: ['ns', 'bp', 'reversal'] },
  },
  model: {
    // author's figures for the ICH-probability model (GFAP + clinical parameters)
    specificity: 97,
    ppv: 90,
    bands: { low: '< 25 %', moderate: '25–49 %', high: '≥ 50 %' },
    source: 'Unpublished model; specificity and PPV are figures provided by the study author, not yet peer reviewed.',
  },
  doorToImaging: {
    // arrival to start of CT/MRI, 1,628 EMS patients with suspected stroke, 3 Düsseldorf stroke centres, 2021-22
    p25: 21, median: 32, p75: 50,
    source: 'Weiss D, et al. BMC Emerg Med. 2024;24:224 (Table 1)',
  },
  start: { lon: 9.1918, lat: 48.8975 }, // Ludwigsburg area, first view
  // jump-to list (keyboard-accessible placement); all checked to have drive-time data on 20.10.2026
  places: [
    { name: 'Stuttgart-Zuffenhausen', lon: 9.1918, lat: 48.8975 },
    { name: 'Berlin-Mitte', lon: 13.40, lat: 52.52 },
    { name: 'Hamburg', lon: 9.99, lat: 53.55 },
    { name: 'München', lon: 11.575, lat: 48.137 },
    { name: 'Leipzig', lon: 12.375, lat: 51.34 },
    { name: 'Zwiesel (Bayerischer Wald)', lon: 13.233, lat: 49.017 },
    { name: 'Daun (Eifel)', lon: 6.832, lat: 50.198 },
    { name: 'Husum (Nordfriesland)', lon: 9.05, lat: 54.48 },
    { name: 'Anklam (Vorpommern)', lon: 13.69, lat: 53.856 },
    { name: 'Prenzlau (Uckermark)', lon: 13.862, lat: 53.316 },
  ],
};

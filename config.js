// Simulator settings in one place (design section 7.1). Change cut-offs, test time or model figures here only.
export const config = {
  A: 15, // minutes from starting the test to the result (assumed whole-blood workflow)
  kValues: [0.8, 1.0, 1.3], // driving-time factor: blue light, normal car speed, slow
  kDefault: 1.0,
  bothMaxExtraMin: 10, // prefer the hospital with neurosurgery AND stroke unit if at most this much further
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
    source: '[to supply: publication or protocol of the ICH-probability model]',
  },
  doorToImaging: {
    // arrival to start of CT/MRI, 1,628 EMS patients with suspected stroke, 3 Düsseldorf stroke centres, 2021-22
    p25: 21, median: 32, p75: 50,
    source: 'Weiss D, et al. BMC Emerg Med. 2024;24:224 (Table 1)',
  },
  start: { lon: 9.1918, lat: 48.8975 }, // Ludwigsburg area, first view
};

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
  // Neurosurgery sites left out of the simulator: groups A (not an emergency destination) and B (doubtful) of
  // report/manuscript/ns_site_check_2026-10-20.csv (author's decision, 20.10.2026). The registered analysis and
  // destinations.csv are unchanged.
  excludedSites: {
    NS004: 'Helios Klinik Kiel, Kiel: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS007: 'Helios Agnes Karll Krankenhaus, Bad Schwartau: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS008: 'Ostsee-Klinik – Bad Schwartau, Bad Schwartau: outpatient surgery clinic (insurer pages describe ambulante Eingriffe) (group A)',
    NS010: 'VAMED Ostseeklinik Damp, Damp: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS011: 'Klinikum Glückstadt, Glückstadt: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS017: 'AKK Altonaer Kinderkrankenhaus gGmbH, Hamburg: children\'s hospital (Altonaer Kinderkrankenhaus): not an adult stroke destination (group A)',
    NS019: 'Helios ENDO-Klinik Hamburg GmbH, Hamburg: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS020: 'Privita-Komfortklinik in der Asklepios Klinik Nord, Hamburg: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS028: 'INI International Neuroscience Institute Hannover, Hannover: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS040: 'Rheinland Klinikum, Neuss: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS072: 'Meliva Dalberg Klinik, Fulda: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS081: 'Emma Klinik, Seligenstadt: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS082: 'Wirbelsäulenzentrum Rhein-Main GbR, Offenbach: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS092: 'Gesellschaft für Mikroneurochirurgie, Gensingen: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS113: 'NC Klinik am Forum, Ludwigsburg: outpatient practice, no surgery (study author) (group A)',
    NS117: 'Dr. Lubos Kliniken Bogenhausen, München: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS150: 'Helios Privatklinik Dachau, Dachau: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS160: 'Klinik Helle Mitte, Berlin: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS161: 'Avicenna Klinik, Berlin: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS164: 'HELIOS Privatkliniken Betriebsstätte Berlin-Buch, Berlin: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS173: 'HELIOS Privatkliniken GmbH Betriebsstätte Bad Saarow, Bad Saarow: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS175: 'Klinik Sanssouci Potsdam, Potsdam: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS177: 'Short Care Klinik Greifswald GmbH, Greifswald: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS181: 'Helios Privatklinik Schwerin, Schwerin: register: emergency tier 0 (no participation in inpatient emergency care) and no special emergency module (group A)',
    NS074: 'Werner Wicker Klinik, Bad Wildungen: orthopaedic spine and spinal-cord-injury centre; no evidence of emergency cranial neurosurgery (group B)',
    NS079: 'Klinikum Fulda, Gersfeld: Gersfeld outpost of Klinikum Fulda; main neurosurgery is in Fulda (group B)',
    NS089: 'Klinikum der Stadt Ludwigshafen am Rhein gGmbH, Ludwigshafen am Rhein: no own neurosurgery department found; city hospital cooperates with BG Klinik Ludwigshafen and Mannheim (1 register bed) (group B)',
    NS109: 'Universitätsklinikum Ulm, Ulm: Ulm neurosurgery is at the main campus and Günzburg; this Michelsberg site has 1 register bed (group B)',
    NS134: 'ANregiomed gKU, AöR, Ansbach: Sektion Neurochirurgie listed, but sources conflict (Dinkelsbühl; private-only neurosurgeon at the address) (group B)',
    NS152: 'Krankenhaus Saarlouis vom DRK, Saarlouis: neurosurgery as Belegabteilung (contract surgeons with practice hours); 2025 brochure no longer lists it (group B)',
  },
  // Live road routes (tool data, not study results). Only simulated ambulance coordinates are sent.
  routing: { url: 'https://router.project-osrm.org', candidates: 8, timeoutMs: 5000, debounceMs: 350 },
  start: { lon: 9.1918, lat: 48.8975 }, // Ludwigsburg area, first view
  // jump-to list (keyboard-accessible placement); all checked to have drive-time data on 20.10.2026
  places: [
    { name: 'Ludwigsburg', lon: 9.1918, lat: 48.8975 },
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

// Drive-time grid lookup. Layout written by src/simulator_build.py: uint16 little-endian, row-major,
// row 0 = southernmost 1 km row of EPSG:3035, 6 values per square
// (su_idx, su_t, ns_idx, ns_t, both_idx, both_t), times in tenths of a minute at k = 1, 0xFFFF = no data.
import { toLaea } from './laea.js?v=33';

const NO_DATA = 0xffff;

export class Grid {
  constructor(manifest, arrayBuffer) {
    this.m = manifest;
    this.v = new Uint16Array(arrayBuffer);
  }

  /** null for outside the grid or no road; otherwise hospital indices and minutes at k = 1. */
  lookup(lon, lat) {
    const [e, n] = toLaea(lon, lat);
    const col = Math.floor((e - this.m.e0) / this.m.cell);
    const row = Math.floor((n - this.m.n0) / this.m.cell);
    if (col < 0 || row < 0 || col >= this.m.ncols || row >= this.m.nrows) return null;
    const k = (row * this.m.ncols + col) * 6;
    const [si, st, ni, nt, bi, bt] = this.v.subarray(k, k + 6);
    if (si === NO_DATA || ni === NO_DATA) return null;
    return {
      su: { idx: si, t: st / 10 },
      ns: { idx: ni, t: nt / 10 },
      both: bi === NO_DATA ? null : { idx: bi, t: bt / 10 },
    };
  }
}

/** Grid from <base>/manifest.json and grid.bin, or null when the drive-time export is not there yet. */
export async function loadGrid(base) {
  try {
    const mr = await fetch(`${base}/manifest.json`);
    if (!mr.ok) return null;
    const manifest = await mr.json();
    const gr = await fetch(`${base}/grid.bin`);
    if (!gr.ok) return null;
    return new Grid(manifest, await gr.arrayBuffer());
  } catch {
    return null;
  }
}

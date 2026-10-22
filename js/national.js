// National view: every 1 km square coloured as in the paper's Figure 2 (latest blood draw that still beats the
// ambulance to the nearest stroke unit), with squares where the chosen blood-draw time is too late greyed.
// Drawn into a Web Mercator image for the map; colours from src/figures.py (DRAW_COL, EXCLUDED_GREY).
import { latestDraw, leadTime } from './story.js?v=25';

/** Colour by the latest blood draw (s) that still works: 15 = only on schedule, 0 = even at departure. */
export const DRAW_COLORS = { 15: '#D55E00', 10: '#E69F00', 5: '#F0E442', 0: '#56B4E9' };
export const LATE_GREY = '#BBBBBB';

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const RGB = Object.fromEntries(Object.entries(DRAW_COLORS).map(([k, v]) => [k, rgb(v)]));
const GREY = rgb(LATE_GREY);

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const mercLat = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

/** RGBA pixels (row 0 = north) for a Web Mercator box. grid.lookup(lon, lat) -> { su: { t } } | null. */
export function nationalPixels(grid, { west, east, south, north, width, height, k, s, A, alpha = 255 }) {
  const px = new Uint8ClampedArray(width * height * 4);
  const y0 = mercY(north), y1 = mercY(south);
  for (let r = 0; r < height; r++) {
    const lat = mercLat(y0 + ((r + 0.5) / height) * (y1 - y0));
    for (let c = 0; c < width; c++) {
      const lon = west + ((c + 0.5) / width) * (east - west);
      const look = grid.lookup(lon, lat);
      if (!look) continue;
      const t = look.su.t * k;
      const col = leadTime(s, t, A) < 0 ? GREY : RGB[latestDraw(t)];
      const i = (r * width + c) * 4;
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = alpha;
    }
  }
  return px;
}

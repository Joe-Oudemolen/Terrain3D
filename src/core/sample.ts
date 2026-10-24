import type { Grid } from './grid';

/**
 * Catmull-Rom weights (a = -0.5) for the 4 taps at offsets -1,0,+1,+2 around
 * the base node, given fractional position t in [0,1). Mirrored exactly in WGSL.
 */
function catmullRom(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1,
    -1.5 * t3 + 2 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2,
  ];
}

function at(g: Grid, x: number, z: number): number {
  const cx = x < 0 ? 0 : x >= g.width ? g.width - 1 : x;
  const cz = z < 0 ? 0 : z >= g.height ? g.height - 1 : z;
  return g.data[cz * g.width + cx];
}

/**
 * Bicubic (Catmull-Rom) sample at world meters. Node (i,j) sits at world
 * (i*cellSize, j*cellSize): u = wx / cellSize, i = floor(u), t = u - i.
 * Sample indices clamp to the grid edge.
 */
export function sampleBicubic(g: Grid, wx: number, wz: number): number {
  const u = wx / g.cellSize;
  const v = wz / g.cellSize;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const wxs = catmullRom(u - i);
  const wzs = catmullRom(v - j);
  let sum = 0;
  for (let dz = 0; dz < 4; dz++) {
    let row = 0;
    for (let dx = 0; dx < 4; dx++) row += wxs[dx] * at(g, i - 1 + dx, j - 1 + dz);
    sum += wzs[dz] * row;
  }
  return sum;
}

/** Bilinear sample at world meters, same node convention and edge clamping. */
export function sampleBilinear(g: Grid, wx: number, wz: number): number {
  const u = wx / g.cellSize;
  const v = wz / g.cellSize;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const tx = u - i;
  const tz = v - j;
  const a = at(g, i, j) * (1 - tx) + at(g, i + 1, j) * tx;
  const b = at(g, i, j + 1) * (1 - tx) + at(g, i + 1, j + 1) * tx;
  return a * (1 - tz) + b * tz;
}

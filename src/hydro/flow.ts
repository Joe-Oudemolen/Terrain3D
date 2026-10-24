import type { Grid } from '../core/grid';
import type { TerrainParams } from '../core/params';
import type { Lake } from './lakes';

const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DZ = [-1, -1, -1, 0, 0, 1, 1, 1];
const INV_DIST = [Math.SQRT1_2, 1, Math.SQRT1_2, 1, 1, Math.SQRT1_2, 1, Math.SQRT1_2];

/**
 * D8 steepest descent. Outlets get -1. Ties are broken by the lowest neighbour cell index.
 * On the epsilon-filled surface every non-outlet, non-lake cell has a strictly lower neighbour.
 * Lake cells are routed explicitly: all of a lake's outflow follows a BFS tree through the lake
 * (deterministic neighbour order) rooted at the lake cell adjacent to `lake.spill` (smallest index),
 * whose receiver is the spill cell itself.
 */
export function flowReceivers(
  surface: Float32Array,
  g: Grid,
  outlets: Uint8Array,
  lakeId: Int32Array,
  lakes: Lake[],
): Int32Array {
  const { width: w, height: hgt } = g;
  const rec = new Int32Array(w * hgt).fill(-1);
  for (let z = 0; z < hgt; z++) {
    for (let x = 0; x < w; x++) {
      const c = z * w + x;
      if (outlets[c] || lakeId[c] >= 0) continue;
      const hc = surface[c];
      let best = -1;
      let bestSlope = 0;
      // neighbour order k = 0..7 is ascending in cell index, so strict > keeps the lowest index on ties
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const nz = z + DZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= hgt) continue;
        const ni = nz * w + nx;
        const s = (hc - surface[ni]) * INV_DIST[k];
        if (s > bestSlope) {
          bestSlope = s;
          best = ni;
        }
      }
      rec[c] = best;
    }
  }
  routeLakes(rec, g, lakeId, lakes);
  return rec;
}

function routeLakes(rec: Int32Array, g: Grid, lakeId: Int32Array, lakes: Lake[]): void {
  if (lakes.length === 0) return;
  const { width: w, height: hgt } = g;
  const queue = new Int32Array(w * hgt);
  const seen = new Uint8Array(w * hgt);
  for (const lake of lakes) {
    const sx = lake.spill % w;
    const sz = (lake.spill - sx) / w;
    let start = -1;
    for (let k = 0; k < 8; k++) {
      const nx = sx + DX[k];
      const nz = sz + DZ[k];
      if (nx < 0 || nz < 0 || nx >= w || nz >= hgt) continue;
      const ni = nz * w + nx;
      if (lakeId[ni] === lake.id && (start < 0 || ni < start)) start = ni;
    }
    if (start < 0) continue;
    rec[start] = lake.spill;
    seen[start] = 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++];
      const x = c % w;
      const z = (c - x) / w;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const nz = z + DZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= hgt) continue;
        const ni = nz * w + nx;
        if (seen[ni] || lakeId[ni] !== lake.id) continue;
        seen[ni] = 1;
        rec[ni] = c;
        queue[tail++] = ni;
      }
    }
  }
}

/**
 * Contributing area in m2. Cells are processed upstream-first via a Kahn topological pass over
 * the receiver graph (O(n), deterministic). Because receivers are strictly lower on the epsilon
 * surface this is a valid descending-surface order. `surface` is only used to guard against
 * non-descending receivers (lake cells, routed explicitly, are exempt when `lakeId` is given).
 */
export function flowAccumulation(
  receivers: Int32Array,
  surface: Float32Array,
  cellArea: number,
  lakeId?: Int32Array,
): Float32Array {
  const n = receivers.length;
  const acc = new Float32Array(n).fill(cellArea);
  const indeg = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    const r = receivers[c];
    if (r >= 0) indeg[r]++;
  }
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let c = 0; c < n; c++) if (indeg[c] === 0) queue[tail++] = c;
  while (head < tail) {
    const c = queue[head++];
    const r = receivers[c];
    if (r < 0) continue;
    if ((!lakeId || lakeId[c] < 0) && !(surface[r] <= surface[c])) throw new Error('flowAccumulation: receiver is not downhill');
    acc[r] += acc[c];
    if (--indeg[r] === 0) queue[tail++] = r;
  }
  if (tail !== n) throw new Error('flowAccumulation: receiver graph has a cycle');
  return acc;
}

/** Contributing area (m2) above which a cell is a river channel. Infinity at rainfall 0. */
export function riverThreshold(p: TerrainParams): number {
  if (p.rainfall <= 0) return Infinity;
  return 4e6 + (0.15e6 - 4e6) * p.rainfall;
}

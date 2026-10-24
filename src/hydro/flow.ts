import type { Grid } from '../core/grid';
import type { TerrainParams } from '../core/params';

const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DZ = [-1, -1, -1, 0, 0, 1, 1, 1];
const INV_DIST = [Math.SQRT1_2, 1, Math.SQRT1_2, 1, 1, Math.SQRT1_2, 1, Math.SQRT1_2];

/**
 * D8 steepest descent. Outlets get -1. Ties are broken by the lowest neighbour cell index.
 * On the epsilon-filled surface every non-outlet cell has a strictly lower neighbour.
 */
export function flowReceivers(surface: Float32Array, g: Grid, outlets: Uint8Array): Int32Array {
  const { width: w, height: hgt } = g;
  const rec = new Int32Array(w * hgt).fill(-1);
  for (let z = 0; z < hgt; z++) {
    for (let x = 0; x < w; x++) {
      const c = z * w + x;
      if (outlets[c]) continue;
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
  return rec;
}

/**
 * Contributing area in m2. Cells are processed upstream-first via a Kahn topological pass over
 * the receiver graph (O(n), deterministic). Because receivers are strictly lower on the epsilon
 * surface this is a valid descending-surface order. `surface` is only used to guard against
 * non-descending receivers.
 */
export function flowAccumulation(
  receivers: Int32Array,
  surface: Float32Array,
  cellArea: number,
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
    if (!(surface[r] <= surface[c])) throw new Error('flowAccumulation: receiver is not downhill');
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

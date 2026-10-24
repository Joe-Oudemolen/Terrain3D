import type { Grid } from '../core/grid';
import { MinHeap } from './heap';

const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DZ = [-1, -1, -1, 0, 0, 1, 1, 1];

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** Smallest float32 strictly greater than v (v finite). */
function nextAfter32(v: number): number {
  if (v === 0) {
    u32[0] = 1;
    return f32[0];
  }
  f32[0] = v;
  if (v > 0) u32[0] += 1;
  else u32[0] -= 1;
  return f32[0];
}

/**
 * Plain priority-flood (Barnes 2014): raises every cell to the lowest level at which water
 * can still escape through an outlet. Flat fills are allowed. Pure: returns a new array.
 */
export function fillDepressions(g: Grid, outlets: Uint8Array): Float32Array {
  return flood(g.data, g.width, g.height, outlets, 0);
}

/**
 * Priority-flood+epsilon (Barnes 2014): like fillDepressions but cells raised to a spill
 * level are lifted by `eps` per step away from the outlet, so every non-outlet cell has a
 * strictly lower 8-neighbour. Never lowers terrain.
 */
export function fillEpsilon(
  surface: Float32Array,
  g: Grid,
  outlets: Uint8Array,
  eps = 1e-3,
): Float32Array {
  return flood(surface, g.width, g.height, outlets, eps);
}

function flood(
  src: Float32Array,
  w: number,
  hgt: number,
  outlets: Uint8Array,
  eps: number,
): Float32Array {
  const n = w * hgt;
  const out = new Float32Array(n);
  const closed = new Uint8Array(n);
  const heap = new MinHeap(Math.max(1024, 2 * (w + hgt)));
  // Cells raised to the current spill level wait in a FIFO (each cell enters at most once).
  const pit = new Int32Array(n);
  let pitHead = 0;
  let pitTail = 0;

  for (let i = 0; i < n; i++) {
    if (outlets[i]) {
      out[i] = src[i];
      closed[i] = 1;
      heap.push(src[i], i);
    }
  }

  while (heap.size > 0 || pitHead < pitTail) {
    let c: number;
    if (pitHead < pitTail && (heap.size === 0 || heap.topKey > out[pit[pitHead]])) {
      c = pit[pitHead++];
    } else {
      c = heap.pop();
    }
    const x = c % w;
    const z = (c - x) / w;
    const oc = out[c];
    let lift = oc;
    if (eps > 0) {
      lift = Math.fround(oc + eps);
      if (!(lift > oc)) lift = nextAfter32(oc);
    }
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const nz = z + DZ[k];
      if (nx < 0 || nz < 0 || nx >= w || nz >= hgt) continue;
      const ni = nz * w + nx;
      if (closed[ni]) continue;
      closed[ni] = 1;
      const s = src[ni];
      if (s <= lift) {
        out[ni] = lift;
        pit[pitTail++] = ni;
      } else {
        out[ni] = s;
        heap.push(s, ni);
      }
    }
  }
  // Cells unreachable from any outlet (no outlets at all) keep their height.
  for (let i = 0; i < n; i++) if (!closed[i]) out[i] = src[i];
  return out;
}

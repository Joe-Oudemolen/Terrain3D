import type { Grid } from '../core/grid';
import type { TerrainParams } from '../core/params';

export interface Lake {
  id: number;
  surface: number;
  cellCount: number;
  /** Cell index of the rim cell through which the lake drains. */
  spill: number;
  /** World meters; cell (i,j) sits at (i*cellSize, j*cellSize), bounds extend half a cell outward. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  areaM2: number;
  /** Simplified boundary ring in world meters. */
  outline: [number, number][];
}

const DEPTH_EPS = 1e-3;
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DZ = [-1, -1, -1, 0, 0, 1, 1, 1];

export function findLakes(
  g: Grid,
  filled: Float32Array,
  ocean: Uint8Array,
  p: TerrainParams,
): { lakeId: Int32Array; lakes: Lake[] } {
  const { width: w, height: hgt, cellSize: cs, data: h } = g;
  const n = w * hgt;
  const lakeId = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  const list = new Int32Array(n); // every depression cell is enqueued at most once overall
  let listLen = 0;
  const minDepth = 5 + (0.25 - 5) * p.lakeFill;
  const lakes: Lake[] = [];

  const isDep = (i: number) => !ocean[i] && filled[i] - h[i] > DEPTH_EPS;

  for (let s = 0; s < n; s++) {
    if (visited[s] || !isDep(s)) continue;
    const start = listLen;
    visited[s] = 1;
    list[listLen++] = s;
    let maxDepth = 0;
    let surface = -Infinity;
    for (let head = start; head < listLen; head++) {
      const c = list[head];
      const d = filled[c] - h[c];
      if (d > maxDepth) maxDepth = d;
      if (filled[c] > surface) surface = filled[c];
      const x = c % w;
      const z = (c - x) / w;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const nz = z + DZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= hgt) continue;
        const ni = nz * w + nx;
        if (visited[ni] || !isDep(ni)) continue;
        visited[ni] = 1;
        list[listLen++] = ni;
      }
    }
    const count = listLen - start;
    const areaM2 = count * cs * cs;
    if (areaM2 < p.minLakeSize || maxDepth < minDepth) continue;

    const id = lakes.length;
    let minX = w;
    let minZ = hgt;
    let maxX = -1;
    let maxZ = -1;
    let spill = -1;
    for (let q = start; q < listLen; q++) {
      const c = list[q];
      lakeId[c] = id;
      const x = c % w;
      const z = (c - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const nz = z + DZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= hgt) continue;
        const ni = nz * w + nx;
        if (isDep(ni)) continue; // same component by construction
        if (spill < 0 || filled[ni] < filled[spill] || (filled[ni] === filled[spill] && ni < spill)) {
          spill = ni;
        }
      }
    }
    lakes.push({
      id,
      surface,
      cellCount: count,
      spill,
      bounds: {
        minX: (minX - 0.5) * cs,
        minZ: (minZ - 0.5) * cs,
        maxX: (maxX + 0.5) * cs,
        maxZ: (maxZ + 0.5) * cs,
      },
      areaM2,
      outline: traceOutline(lakeId, id, w, hgt, minX, minZ, maxX, maxZ, cs),
    });
  }
  return { lakeId, lakes };
}

/** Largest (by area) marching-squares ring of cells labelled `id`, Douglas-Peucker simplified. */
function traceOutline(
  lakeId: Int32Array,
  id: number,
  w: number,
  hgt: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  cs: number,
): [number, number][] {
  const ox = minX - 1;
  const oz = minZ - 1;
  const lw = maxX - minX + 3;
  const lh = maxZ - minZ + 3;
  const inside = (lx: number, lz: number) => {
    const x = lx + ox;
    const z = lz + oz;
    return x >= 0 && z >= 0 && x < w && z < hgt && lakeId[z * w + x] === id ? 1 : 0;
  };
  // Edge midpoint ids: 2*(z*lw+x) horizontal edge (x,z)-(x+1,z); +1 vertical edge (x,z)-(x,z+1).
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    let la = adj.get(a);
    if (!la) adj.set(a, (la = []));
    la.push(b);
    let lb = adj.get(b);
    if (!lb) adj.set(b, (lb = []));
    lb.push(a);
  };
  for (let z = 0; z < lh - 1; z++) {
    for (let x = 0; x < lw - 1; x++) {
      const m =
        inside(x, z) | (inside(x + 1, z) << 1) | (inside(x + 1, z + 1) << 2) | (inside(x, z + 1) << 3);
      if (m === 0 || m === 15) continue;
      const base = z * lw + x;
      const T = 2 * base;
      const B = 2 * (base + lw);
      const L = 2 * base + 1;
      const R = 2 * (base + 1) + 1;
      switch (m) {
        case 1: case 14: link(L, T); break;
        case 2: case 13: link(T, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(R, B); break;
        case 5: link(L, T); link(R, B); break;
        case 6: case 9: link(T, B); break;
        case 7: case 8: link(L, B); break;
        case 10: link(T, R); link(L, B); break;
      }
    }
  }
  const pos = (e: number): [number, number] => {
    const vertical = e & 1;
    const idx = e >> 1;
    const x = idx % lw;
    const z = (idx - x) / lw;
    return vertical
      ? [(x + ox) * cs, (z + oz + 0.5) * cs]
      : [(x + ox + 0.5) * cs, (z + oz) * cs];
  };
  const seen = new Set<number>();
  let best: [number, number][] = [];
  let bestArea = -1;
  for (const startEdge of adj.keys()) {
    if (seen.has(startEdge)) continue;
    const ring: [number, number][] = [];
    let prev = -1;
    let cur = startEdge;
    for (;;) {
      seen.add(cur);
      ring.push(pos(cur));
      const nb = adj.get(cur)!;
      const next = nb[0] !== prev && !seen.has(nb[0]) ? nb[0] : nb.length > 1 && !seen.has(nb[1]) ? nb[1] : -1;
      if (next < 0) break;
      prev = cur;
      cur = next;
    }
    const a = Math.abs(ringArea(ring));
    if (a > bestArea) {
      bestArea = a;
      best = ring;
    }
  }
  return simplifyRing(best, cs);
}

function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, z0] = r[i];
    const [x1, z1] = r[(i + 1) % r.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/** Douglas-Peucker on a closed ring: split at point 0 and the point farthest from it, iteratively. */
function simplifyRing(ring: [number, number][], tol: number): [number, number][] {
  const n = ring.length;
  if (n <= 3) return ring;
  let far = 0;
  let fd = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const stack: number[] = [0, far, far, n]; // (lo, hi) pairs; hi === n wraps to point 0
  while (stack.length) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    const a = ring[lo];
    const b = ring[hi % n];
    let md = -1;
    let mi = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist(ring[i], a, b);
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (mi >= 0 && md > tol) {
      keep[mi] = 1;
      stack.push(lo, mi, mi, hi);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out;
}

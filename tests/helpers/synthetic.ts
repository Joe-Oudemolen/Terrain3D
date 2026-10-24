import { readFileSync } from 'node:fs';
import { makeGrid, type Grid } from '../../src/core/grid';
import { deriveSeed, mulberry32 } from '../../src/core/rng';

/** Flat plateau at rimHeight with a smooth circular bowl (radius 30% of the grid) of the given depth in the centre. */
export function bowlGrid(size: number, cellSize: number, rimHeight: number, depth: number): Grid {
  const g = makeGrid(size, cellSize);
  const c = (size - 1) / 2;
  const r = size * 0.3;
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, z - c) / r;
      g.data[z * size + x] = d >= 1 ? rimHeight : rimHeight - depth * (1 - d * d);
    }
  }
  return g;
}

/** Flat grid at `base` with a square pit (half-width `radiusCells`) of `depth` in the centre. */
export function pitGrid(
  size: number,
  cellSize: number,
  base: number,
  radiusCells: number,
  depth: number,
): Grid {
  const g = makeGrid(size, cellSize);
  g.data.fill(base);
  const c = Math.floor(size / 2);
  for (let z = c - radiusCells; z <= c + radiusCells; z++) {
    for (let x = c - radiusCells; x <= c + radiusCells; x++) g.data[z * size + x] = base - depth;
  }
  return g;
}

/** Smooth value noise in [0, amp] (lattice spacing 8 cells, smoothstep interpolation). */
export function valueNoiseGrid(seed: number, size: number, cellSize: number, amp: number): Grid {
  const g = makeGrid(size, cellSize);
  const step = 8;
  const m = Math.ceil(size / step) + 2;
  const rnd = mulberry32(deriveSeed(seed, 'valueNoiseGrid'));
  const lat = new Float32Array(m * m);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const sm = (t: number) => t * t * (3 - 2 * t);
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const u = x / step;
      const v = z / step;
      const i = Math.floor(u);
      const j = Math.floor(v);
      const tx = sm(u - i);
      const tz = sm(v - j);
      const a = lat[j * m + i] * (1 - tx) + lat[j * m + i + 1] * tx;
      const b = lat[(j + 1) * m + i] * (1 - tx) + lat[(j + 1) * m + i + 1] * tx;
      g.data[z * size + x] = amp * (a * (1 - tz) + b * tz);
    }
  }
  return g;
}

/** Reads a raw little-endian Float32 square fixture. */
export function loadF32(path: string, size: number, cellSize: number): Grid {
  const buf = readFileSync(path);
  const g = makeGrid(size, cellSize);
  if (buf.byteLength !== size * size * 4) {
    throw new Error(`${path}: expected ${size * size * 4} bytes, got ${buf.byteLength}`);
  }
  for (let i = 0; i < size * size; i++) g.data[i] = buf.readFloatLE(i * 4);
  return g;
}

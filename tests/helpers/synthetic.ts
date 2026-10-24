import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { makeGrid, type Grid } from '../../src/core/grid';
import { clampParams, DEFAULT_PARAMS, type TerrainParams } from '../../src/core/params';
import { deriveSeed, mulberry32 } from '../../src/core/rng';
import { flowAccumulation, flowReceivers, resolveSpills, riverThreshold } from '../../src/hydro/flow';
import { findLakes, type Lake } from '../../src/hydro/lakes';
import { extractNetwork, type RiverPath } from '../../src/hydro/network';
import { labelOcean, outletMask } from '../../src/hydro/ocean';
import { fillDepressions, fillEpsilon } from '../../src/hydro/priorityFlood';
import { buildRivers, type River } from '../../src/hydro/riverGeometry';

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

export interface HydroRun {
  rivers: River[];
  paths: RiverPath[];
  lakes: Lake[];
  /** Pit-filled hydro terrain: epsilon-filled surface outside lakes, original height on lake cells. */
  terrain: Grid;
}

/**
 * Hydrology + river geometry on a heightmap: ocean, flood, lakes, flow, network, buildRivers.
 * `thresholdCells` overrides the rainfall-derived channel threshold (in cells).
 */
export function hydroPipeline(g: Grid, p: TerrainParams, thresholdCells?: number): HydroRun {
  const ocean = labelOcean(g);
  const outlets = outletMask(g, ocean);
  const plain = fillDepressions(g, outlets);
  const { lakeId, lakes } = findLakes(g, plain, ocean, p);
  const surface = fillEpsilon(g.data, g, outlets);
  resolveSpills(lakes, lakeId, surface, g);
  const receivers = flowReceivers(surface, g, outlets, lakeId, lakes);
  const cs2 = g.cellSize * g.cellSize;
  const acc = flowAccumulation(receivers, surface, cs2, lakeId);
  const thr = thresholdCells === undefined ? riverThreshold(p) : thresholdCells * cs2;
  const paths = extractNetwork(g, receivers, acc, lakeId, lakes, ocean, thr);
  const terrain: Grid = { width: g.width, height: g.height, cellSize: g.cellSize, data: new Float32Array(surface) };
  for (let c = 0; c < lakeId.length; c++) if (lakeId[c] >= 0) terrain.data[c] = g.data[c];
  return { rivers: buildRivers(paths, terrain, lakes, p), paths, lakes, terrain };
}

/** 256 x 40 m (the full 10240 m world) value-noise terrain, 0..300 m lowered by 40 m so low borders become ocean. */
export function syntheticTerrain(seed: number): Grid {
  const g = valueNoiseGrid(seed, 256, 40, 300);
  for (let i = 0; i < g.data.length; i++) g.data[i] -= 40;
  return g;
}

export function pipelineOnSynthetic(seed: number, p: Partial<TerrainParams> = {}): River[] {
  return hydroPipeline(syntheticTerrain(seed), clampParams({ ...DEFAULT_PARAMS, seed, ...p })).rivers;
}

/** Water never rises downstream: water[i+1] <= water[i] + tol along every river. */
export function assertNeverUphill(rivers: River[], tol = 1e-4): void {
  for (const r of rivers) {
    for (let i = 1; i < r.points.length; i++) {
      const rise = r.points[i].water - r.points[i - 1].water;
      if (rise > tol) {
        expect.fail(`river ${r.id} rises ${rise} m between points ${i - 1} and ${i}`);
      }
    }
  }
}

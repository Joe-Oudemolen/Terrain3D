import type { Grid } from '../core/grid';
import type { TerrainParams } from '../core/params';
import { deriveSeed, mulberry32 } from '../core/rng';
import { sampleBicubic } from '../core/sample';
import type { Lake } from './lakes';
import type { Endpoint, RiverPath } from './network';

export interface RiverPoint {
  /** World meters. */
  x: number;
  z: number;
  /** Water surface height (m). Non-increasing from source to mouth. */
  water: number;
  /** Channel width and depth (m). Non-decreasing from source to mouth. */
  width: number;
  depth: number;
  /** Contributing area (m2). */
  flow: number;
}

export interface River {
  id: number;
  points: RiverPoint[];
  source: Endpoint;
  /**
   * For a tributary (`type: 'river'`), `pointIndex` indexes the main River's `points` (not the
   * RiverPath's cells): `main.points[pointIndex]` has exactly this river's last x/z.
   */
  outlet: Endpoint;
}

const CHAIKIN_ITERATIONS = 3;
/** A meander offset is rejected if the terrain under it is this much higher than under the centerline. */
const MEANDER_MAX_RISE = 0.5;
/** Along-channel slope at which meanders vanish. */
const MEANDER_SLOPE = 0.05;
/** Half-window (in resampled points) of the centered difference used for the along-channel slope. */
const SLOPE_HALF_WINDOW = 2;

interface Polyline {
  x: number[];
  z: number[];
  /** Fractional cell index along the RiverPath (0 = first cell). Interpolated like positions. */
  t: number[];
}

/** One Chaikin corner-cutting pass on an open polyline; first and last vertices are kept. */
function chaikin(p: Polyline): Polyline {
  const n = p.x.length;
  if (n < 3) return p;
  const out: Polyline = { x: [p.x[0]], z: [p.z[0]], t: [p.t[0]] };
  for (let i = 0; i + 1 < n; i++) {
    for (const f of [0.25, 0.75]) {
      out.x.push(p.x[i] + (p.x[i + 1] - p.x[i]) * f);
      out.z.push(p.z[i] + (p.z[i + 1] - p.z[i]) * f);
      out.t.push(p.t[i] + (p.t[i + 1] - p.t[i]) * f);
    }
  }
  out.x.push(p.x[n - 1]);
  out.z.push(p.z[n - 1]);
  out.t.push(p.t[n - 1]);
  return out;
}

/** Resamples by arc length into round(L / spacing) equal segments; both endpoints are kept exactly. */
function resample(p: Polyline, spacing: number): { line: Polyline; step: number } {
  const n = p.x.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(p.x[i] - p.x[i - 1], p.z[i] - p.z[i - 1]));
  const len = cum[n - 1];
  const segs = Math.max(1, Math.round(len / spacing));
  const step = len / segs;
  const out: Polyline = { x: [p.x[0]], z: [p.z[0]], t: [p.t[0]] };
  let k = 0;
  for (let j = 1; j < segs; j++) {
    const s = j * step;
    while (k + 2 < n && cum[k + 1] < s) k++;
    const d = cum[k + 1] - cum[k];
    const f = d > 0 ? (s - cum[k]) / d : 0;
    out.x.push(p.x[k] + (p.x[k + 1] - p.x[k]) * f);
    out.z.push(p.z[k] + (p.z[k + 1] - p.z[k]) * f);
    out.t.push(p.t[k] + (p.t[k + 1] - p.t[k]) * f);
  }
  out.x.push(p.x[n - 1]);
  out.z.push(p.z[n - 1]);
  out.t.push(p.t[n - 1]);
  return { line: out, step };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Index of the point whose cell parameter is closest to `cell` (ties: lowest index). */
function pointForCell(t: number[], cell: number): number {
  let best = 0;
  for (let j = 1; j < t.length; j++) if (Math.abs(t[j] - cell) < Math.abs(t[best] - cell)) best = j;
  return best;
}

/**
 * Turns river cell chains into smooth, gently meandering world-space polylines with widths,
 * depths and water heights. Rivers are built in id order (mains before their tributaries).
 * Water is a running minimum of (terrain - freeboard), then raised to the outlet level, as the
 * final step, so it never increases downstream whatever the geometry steps did.
 * `terrain` is the pit-filled hydro terrain.
 */
export function buildRivers(paths: RiverPath[], terrain: Grid, lakes: Lake[], p: TerrainParams): River[] {
  const cs = terrain.cellSize;
  const w = terrain.width;
  const lakeById = new Map(lakes.map((l) => [l.id, l]));
  const lakeOf = (id: number) => {
    const l = lakeById.get(id);
    if (!l) throw new Error(`buildRivers: unknown lake ${id}`);
    return l;
  };

  // Junction cells (indices into the main path's cells) named by each river's tributaries.
  const junctionCells = new Map<number, number[]>();
  for (const path of paths) {
    if (path.outlet.type !== 'river') continue;
    const list = junctionCells.get(path.outlet.id) ?? [];
    list.push(path.outlet.pointIndex);
    junctionCells.set(path.outlet.id, list);
  }

  const built = new Map<number, { river: River; cellToPoint: Map<number, number> }>();
  const ordered = [...paths].sort((a, b) => a.id - b.id);
  for (const path of ordered) {
    let main: { river: River; cellToPoint: Map<number, number> } | undefined;
    let junction = -1;
    if (path.outlet.type === 'river') {
      main = built.get(path.outlet.id);
      if (!main) throw new Error(`buildRivers: river ${path.id} joins river ${path.outlet.id}, which is not built first`);
      junction = main.cellToPoint.get(path.outlet.pointIndex)!;
    }

    // 1. Centerline: cell positions, the last pinned to the main river's junction point, then Chaikin.
    let line: Polyline = {
      x: path.cells.map((c) => (c % w) * cs),
      z: path.cells.map((c) => Math.floor(c / w) * cs),
      t: path.cells.map((_, k) => k),
    };
    const last = path.cells.length - 1;
    if (main) {
      line.x[last] = main.river.points[junction].x;
      line.z[last] = main.river.points[junction].z;
    }
    for (let it = 0; it < CHAIKIN_ITERATIONS; it++) line = chaikin(line);
    const { line: c, step } = resample(line, cs);
    const m = c.x.length;

    // 3. Width and depth from flow, made non-decreasing downstream.
    const flow: number[] = [];
    const width: number[] = [];
    const depth: number[] = [];
    for (let j = 0; j < m; j++) {
      const k = Math.min(Math.floor(c.t[j]), last);
      const f = c.t[j] - k;
      const q = k < last ? path.flow[k] + (path.flow[k + 1] - path.flow[k]) * f : path.flow[last];
      flow.push(q);
      const wd = clamp(p.riverWidth * 0.004 * Math.sqrt(q), 2, 60);
      const dp = clamp(0.25 * Math.sqrt(wd), 0.3, 2.5);
      width.push(j > 0 ? Math.max(wd, width[j - 1]) : wd);
      depth.push(j > 0 ? Math.max(dp, depth[j - 1]) : dp);
    }

    // Pinned points: endpoints and junctions with this river's tributaries.
    const pinned = new Uint8Array(m);
    pinned[0] = 1;
    pinned[m - 1] = 1;
    const cellToPoint = new Map<number, number>();
    for (const cell of junctionCells.get(path.id) ?? []) {
      const j = pointForCell(c.t, cell);
      cellToPoint.set(cell, j);
      pinned[j] = 1;
    }

    // 2. Meander: lateral sine offset, damped by along-channel slope, rejected where it climbs a wall.
    // The phase is integrated (dθ = 2π ds / λ) since λ = 12·width varies along the river.
    const base = c.x.map((x, j) => sampleBicubic(terrain, x, c.z[j]));
    const nx = new Float64Array(m);
    const nz = new Float64Array(m);
    const raw = new Float64Array(m); // signed lateral offset per point
    const fixed = pinned.slice(); // points held at zero offset (pinned or rejected)
    let theta = 2 * Math.PI * mulberry32(deriveSeed(p.seed, 'meander' + path.id))();
    for (let j = 0; j < m; j++) {
      if (j > 0) theta += (2 * Math.PI * step) / (12 * width[j]);
      if (pinned[j]) continue;
      const tx = c.x[j + 1] - c.x[j - 1];
      const tz = c.z[j + 1] - c.z[j - 1];
      const tl = Math.hypot(tx, tz);
      if (tl === 0) {
        fixed[j] = 1;
        continue;
      }
      nx[j] = -tz / tl;
      nz[j] = tx / tl;
      const j0 = Math.max(0, j - SLOPE_HALF_WINDOW);
      const j1 = Math.min(m - 1, j + SLOPE_HALF_WINDOW);
      const run = (j1 - j0) * step;
      const slope = run > 0 ? Math.abs(base[j0] - base[j1]) / run : 0;
      raw[j] = width[j] * 1.2 * (1 - clamp(slope / MEANDER_SLOPE, 0, 1)) * Math.sin(theta);
    }
    const climbs = (j: number, off: number) =>
      sampleBicubic(terrain, c.x[j] + nx[j] * off, c.z[j] + nz[j] * off) > base[j] + MEANDER_MAX_RISE;
    for (let j = 0; j < m; j++) if (!fixed[j] && raw[j] !== 0 && climbs(j, raw[j])) fixed[j] = 1;
    // Taper toward zero-offset points: moving average (window ≈ λ/4) of the offsets with fixed
    // points at zero, then re-check rejection on the smoothed offsets until nothing new is rejected.
    const off = new Float64Array(m);
    for (let changed = true; changed; ) {
      changed = false;
      for (let j = 0; j < m; j++) {
        if (fixed[j]) {
          off[j] = 0;
          continue;
        }
        const h = Math.max(1, Math.round((12 * width[j]) / 8 / step));
        let sum = 0;
        let cnt = 0;
        for (let k = j - h; k <= j + h; k++) {
          if (k < 0 || k >= m) continue;
          sum += fixed[k] ? 0 : raw[k];
          cnt++;
        }
        off[j] = sum / cnt;
      }
      for (let j = 0; j < m; j++) {
        if (!fixed[j] && off[j] !== 0 && climbs(j, off[j])) {
          fixed[j] = 1;
          changed = true;
        }
      }
    }
    const px = c.x.map((x, j) => x + nx[j] * off[j]);
    const pz = c.z.map((z, j) => z + nz[j] * off[j]);

    // 4. Water: running min of (terrain - freeboard), then raised to the outlet level (last step).
    const water: number[] = [];
    for (let j = 0; j < m; j++) {
      const raw = sampleBicubic(terrain, px[j], pz[j]) - (0.15 + 0.05 * width[j]);
      if (j === 0) water.push(path.source.type === 'lake' ? lakeOf(path.source.id).surface : raw);
      else water.push(Math.min(raw, water[j - 1]));
    }
    let level = -Infinity;
    if (path.outlet.type === 'lake') level = lakeOf(path.outlet.id).surface;
    else if (path.outlet.type === 'ocean') level = 0;
    else if (main) level = main.river.points[junction].water;
    for (let j = 0; j < m; j++) water[j] = Math.max(water[j], level);

    const points: RiverPoint[] = [];
    for (let j = 0; j < m; j++) {
      points.push({ x: px[j], z: pz[j], water: water[j], width: width[j], depth: depth[j], flow: flow[j] });
    }
    const outlet: Endpoint = main ? { type: 'river', id: main.river.id, pointIndex: junction } : path.outlet;
    built.set(path.id, { river: { id: path.id, points, source: path.source, outlet }, cellToPoint });
  }
  return ordered.map((path) => built.get(path.id)!.river);
}

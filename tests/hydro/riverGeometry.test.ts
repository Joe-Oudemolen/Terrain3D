import { describe, expect, test } from 'vitest';
import { makeGrid, type Grid } from '../../src/core/grid';
import { DEFAULT_PARAMS, type TerrainParams } from '../../src/core/params';
import type { Lake } from '../../src/hydro/lakes';
import type { River } from '../../src/hydro/riverGeometry';
import {
  assertNeverUphill,
  bowlGrid,
  hydroPipeline,
  loadF32,
  pipelineOnSynthetic,
  syntheticTerrain,
} from '../helpers/synthetic';

const P: TerrainParams = { ...DEFAULT_PARAMS };

function assertWidthDepthMonotone(rivers: River[]) {
  for (const r of rivers) {
    for (let i = 1; i < r.points.length; i++) {
      expect(r.points[i].width).toBeGreaterThanOrEqual(r.points[i - 1].width);
      expect(r.points[i].depth).toBeGreaterThanOrEqual(r.points[i - 1].depth);
    }
    for (const q of r.points) {
      expect(q.width).toBeGreaterThanOrEqual(2);
      expect(q.width).toBeLessThanOrEqual(60);
      expect(q.depth).toBeGreaterThanOrEqual(0.3);
      expect(q.depth).toBeLessThanOrEqual(2.5);
    }
  }
}

/** Returns how many tributaries were checked. */
function assertTributaryRule(rivers: River[]): number {
  const byId = new Map(rivers.map((r) => [r.id, r]));
  let n = 0;
  for (const r of rivers) {
    if (r.outlet.type !== 'river') continue;
    const main = byId.get(r.outlet.id)!;
    expect(main).toBeDefined();
    const j = main.points[r.outlet.pointIndex];
    expect(j).toBeDefined();
    const last = r.points[r.points.length - 1];
    expect(last.x).toBe(j.x);
    expect(last.z).toBe(j.z);
    expect(last.water).toBeGreaterThanOrEqual(j.water);
    n++;
  }
  return n;
}

/** Returns how many lake-outlet rivers were checked. */
function assertLakeRules(rivers: River[], lakes: Lake[]): number {
  const byId = new Map(lakes.map((l) => [l.id, l]));
  let n = 0;
  for (const r of rivers) {
    if (r.source.type === 'lake') {
      expect(r.points[0].water).toBe(byId.get(r.source.id)!.surface);
      n++;
    }
    if (r.outlet.type === 'lake') {
      expect(r.points[r.points.length - 1].water).toBeGreaterThanOrEqual(byId.get(r.outlet.id)!.surface);
    }
    if (r.outlet.type === 'ocean') expect(r.points[r.points.length - 1].water).toBeGreaterThanOrEqual(0);
  }
  return n;
}

/** Straight valley along the middle column of a size x size grid, draining to z = 0. Slopes in m/m. */
function straightValley(size: number, cs: number, alongSlope: number, crossSlope: number): Grid {
  const g = makeGrid(size, cs);
  const mid = (size - 1) / 2;
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++)
      g.data[z * size + x] = 100 + crossSlope * cs * Math.abs(x - mid) + alongSlope * cs * z;
  return g;
}

/** Max |x - valley axis| / width over a river's points. */
function maxLateral(r: River, g: Grid): number {
  const axis = ((g.width - 1) / 2) * g.cellSize;
  let m = 0;
  for (const q of r.points) m = Math.max(m, Math.abs(q.x - axis) / q.width);
  return m;
}

function maxTurnDeg(r: River): number {
  let m = 0;
  const pts = r.points;
  for (let i = 1; i + 1 < pts.length; i++) {
    const ax = pts[i].x - pts[i - 1].x;
    const az = pts[i].z - pts[i - 1].z;
    const bx = pts[i + 1].x - pts[i].x;
    const bz = pts[i + 1].z - pts[i].z;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la === 0 || lb === 0) continue;
    const c = Math.min(1, Math.max(-1, (ax * bx + az * bz) / (la * lb)));
    m = Math.max(m, (Math.acos(c) * 180) / Math.PI);
  }
  return m;
}

describe('buildRivers', () => {
  test('never uphill on synthetic terrains', () => {
    let total = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rivers = pipelineOnSynthetic(seed);
      total += rivers.length;
      assertNeverUphill(rivers);
    }
    expect(total).toBeGreaterThan(30);
  });

  test('assertNeverUphill catches a rising river', () => {
    const pt = (water: number) => ({ x: 0, z: 0, water, width: 2, depth: 0.3, flow: 1 });
    const bad: River = { id: 0, points: [pt(10), pt(9), pt(9.01)], source: { type: 'spring' }, outlet: { type: 'edge' } };
    expect(() => assertNeverUphill([bad])).toThrow();
    expect(() => assertNeverUphill([{ ...bad, points: [pt(10), pt(9), pt(9.00005)] }])).not.toThrow();
  });

  test('width and depth non-decreasing downstream', () => {
    for (let seed = 1; seed <= 10; seed++) assertWidthDepthMonotone(pipelineOnSynthetic(seed));
  });

  test('width grows with flow and riverWidth scales width only', () => {
    const narrow = pipelineOnSynthetic(3, { riverWidth: 0.5 });
    const wide = pipelineOnSynthetic(3, { riverWidth: 2 });
    const main = (rs: River[]) => rs[0].points[rs[0].points.length - 1];
    expect(main(wide).width).toBeGreaterThan(main(narrow).width);
    const r = wide[0];
    expect(r.points[r.points.length - 1].width).toBeGreaterThan(r.points[0].width);
    for (const q of r.points) {
      expect(q.depth).toBeCloseTo(Math.min(2.5, Math.max(0.3, 0.25 * Math.sqrt(q.width))), 0);
    }
  });

  test('tributary end water >= main water at junction, at the exact junction point', () => {
    let n = 0;
    for (let seed = 1; seed <= 30; seed++) n += assertTributaryRule(pipelineOnSynthetic(seed, { rainfall: 0.9 }));
    expect(n).toBeGreaterThan(5);
  });

  test('lake outlet starts at lake surface', () => {
    // tilted bowl from the network tests: one lake with an outlet river at its spill
    const g = bowlGrid(100, 10, 100, 30);
    for (let z = 0; z < 100; z++) for (let x = 0; x < 100; x++) g.data[z * 100 + x] += 0.01 * x + 0.02 * z;
    const { rivers, lakes } = hydroPipeline(g, P, 500);
    expect(lakes).toHaveLength(1);
    expect(assertLakeRules(rivers, lakes)).toBe(1);
    assertNeverUphill(rivers);
    let n = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const run = hydroPipeline(syntheticTerrain(seed), { ...P, seed });
      n += assertLakeRules(run.rivers, run.lakes);
    }
    expect(n).toBeGreaterThan(0);
  });

  test('river into ocean ends with water >= 0', () => {
    let n = 0;
    for (let seed = 1; seed <= 30; seed++) {
      for (const r of pipelineOnSynthetic(seed)) {
        if (r.outlet.type !== 'ocean') continue;
        expect(r.points[r.points.length - 1].water).toBeGreaterThanOrEqual(0);
        n++;
      }
    }
    expect(n).toBeGreaterThan(5);
  });

  test('endpoints sit at their cell centres', () => {
    const { rivers, paths, terrain } = hydroPipeline(syntheticTerrain(4), { ...P, seed: 4 });
    const cs = terrain.cellSize;
    for (const r of rivers) {
      const cells = paths[r.id].cells;
      expect(r.points[0].x).toBe((cells[0] % terrain.width) * cs);
      expect(r.points[0].z).toBe(Math.floor(cells[0] / terrain.width) * cs);
      if (r.outlet.type === 'river') continue;
      const last = cells[cells.length - 1];
      expect(r.points[r.points.length - 1].x).toBe((last % terrain.width) * cs);
      expect(r.points[r.points.length - 1].z).toBe(Math.floor(last / terrain.width) * cs);
    }
  });

  test('meander amplitude ~0 on steep slopes, > 0 on flats', () => {
    const steepG = straightValley(65, 20, 0.1, 0.3);
    const steep = hydroPipeline(steepG, { ...P, rainfall: 1 }).rivers;
    expect(steep).toHaveLength(1);
    expect(steep[0].points.length).toBeGreaterThan(30);
    expect(maxLateral(steep[0], steepG)).toBeLessThan(0.1);
    // 5 m cells (2048 base): widths ~2-3 m, so λ = 12·width spans several samples
    const flatG = straightValley(129, 5, 0.001, 0.05);
    const flat = hydroPipeline(flatG, { ...P, rainfall: 1 }).rivers;
    expect(flat).toHaveLength(1);
    expect(maxLateral(flat[0], flatG)).toBeGreaterThan(0.3);
    expect(maxLateral(flat[0], flatG)).toBeLessThanOrEqual(1.2 + 1e-9);
    assertNeverUphill(flat);
  });

  test('meanders taper smoothly: max turn < 45° on meandering flats', () => {
    const g = straightValley(129, 5, 0.001, 0.05);
    for (const seed of [1, 2, 3, 4, 5]) {
      const rivers = hydroPipeline(g, { ...P, seed, rainfall: 1 }).rivers;
      expect(maxLateral(rivers[0], g)).toBeGreaterThan(0.3);
      expect(maxTurnDeg(rivers[0])).toBeLessThan(45);
    }
  });

  test('meanders do not climb valley walls', () => {
    // flat floor but walls rising 30 m per metre: every offset is rejected
    const g = straightValley(129, 5, 0.001, 30);
    const rivers = hydroPipeline(g, { ...P, rainfall: 1 }).rivers;
    expect(rivers).toHaveLength(1);
    expect(maxLateral(rivers[0], g)).toBeLessThan(0.1);
  });

  test('smoothed polyline has no 45°/90° stair-steps', () => {
    // steep valley along the line x = 10 + z/2: the D8 cell chain zig-zags with 45° turns
    const S = 65;
    const g = makeGrid(S, 20);
    for (let z = 0; z < S; z++)
      for (let x = 0; x < S; x++) g.data[z * S + x] = 100 + 0.3 * 20 * Math.abs(x - 10 - z / 2) + 0.1 * 20 * z;
    const { rivers, paths } = hydroPipeline(g, { ...P, rainfall: 1 });
    expect(rivers.length).toBeGreaterThanOrEqual(1);
    // sanity: the raw cell chain really has stair-steps
    const cells = paths[0].cells;
    const dirs = new Set<number>();
    for (let k = 1; k < cells.length; k++) dirs.add(cells[k] - cells[k - 1]);
    expect(dirs.size).toBeGreaterThan(1);
    expect(maxTurnDeg(rivers[0])).toBeLessThan(35);
  });

  test('deterministic', () => {
    const a = pipelineOnSynthetic(7);
    expect(a.length).toBeGreaterThan(0);
    expect(pipelineOnSynthetic(7)).toEqual(a);
  });
});

describe('buildRivers on eroded fixtures', () => {
  for (const s of [1, 2, 3]) {
    for (const rainfall of [0.2, 0.5, 0.9]) {
      test(`fixture ${s}, rainfall ${rainfall}: never uphill, tributary and lake rules`, () => {
        const g = loadF32(`tests/fixtures/eroded_s${s}_512.f32`, 512, 20);
        const { rivers, lakes } = hydroPipeline(g, { ...P, seed: s, rainfall });
        expect(rivers.length).toBeGreaterThan(0);
        assertNeverUphill(rivers);
        assertWidthDepthMonotone(rivers);
        assertTributaryRule(rivers);
        assertLakeRules(rivers, lakes);
      });
    }
  }
});

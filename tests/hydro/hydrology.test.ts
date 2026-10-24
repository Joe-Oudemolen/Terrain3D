import { describe, expect, test } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import { clampParams } from '../../src/core/params';
import { runHydrology } from '../../src/hydro/hydrology';
import { assertNeverUphill, loadF32 } from '../helpers/synthetic';

const fixtures = [1, 2, 3].map((s) => loadF32(`tests/fixtures/eroded_s${s}_512.f32`, 512, 20));

describe('runHydrology', () => {
  test('never uphill on real eroded fixtures x settings', () => {
    for (const f of fixtures) {
      for (const rainfall of [0.2, 0.5, 0.9]) {
        for (const island of [false, true]) {
          const r = runHydrology(f, clampParams({ rainfall, island }));
          assertNeverUphill(r.rivers);
        }
      }
    }
  });

  test('fixtures produce at least one river at default rainfall', () => {
    for (const f of fixtures) expect(runHydrology(f, clampParams({})).rivers.length).toBeGreaterThan(0);
  });

  test('degenerate settings', () => {
    const f = fixtures[0];
    expect(runHydrology(f, clampParams({ rainfall: 0 })).rivers).toEqual([]);
    const sea = makeGrid(64, 20);
    sea.data.set(f.data.subarray(0, 64 * 64));
    expect(() => runHydrology(sea, clampParams({ seaLevel: 0.5, mountainHeight: 100 }))).not.toThrow();
    const flat = makeGrid(64, 20);
    const r = runHydrology(flat, clampParams({ flatland: 1 }));
    expect(r.lakes).toEqual([]);
    expect(r.rivers).toEqual([]);
    for (const a of [r.terrain.data, r.detailMask.data]) expect(a.every(Number.isFinite)).toBe(true);
  });

  test('terrain >= original except lake beds equal original', () => {
    for (const f of fixtures) {
      const r = runHydrology(f, clampParams({}));
      for (let i = 0; i < f.data.length; i++) {
        if (r.lakeId[i] >= 0) expect(r.terrain.data[i]).toBe(f.data[i]);
        else expect(r.terrain.data[i]).toBeGreaterThanOrEqual(f.data[i]);
      }
    }
  });

  test('detailMask is 0 on river centerlines and lake cells, 1 far away, reports progress', () => {
    const progress: number[] = [];
    const r = runHydrology(fixtures[0], clampParams({}), (x) => progress.push(x));
    expect(progress[progress.length - 1]).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    const g = r.detailMask;
    const cs = g.cellSize;
    let zeroLake = 0;
    for (let i = 0; i < r.lakeId.length; i++) {
      if (r.lakeId[i] >= 0) {
        expect(g.data[i]).toBe(0);
        zeroLake++;
      }
    }
    for (const river of r.rivers) {
      for (const pt of river.points) {
        const x = Math.round(pt.x / cs);
        const z = Math.round(pt.z / cs);
        if (x < 0 || z < 0 || x >= g.width || z >= g.height) continue;
        expect(g.data[z * g.width + x]).toBe(0);
      }
    }
    expect(zeroLake + r.rivers.length).toBeGreaterThan(0);
    expect(g.data.some((v) => v === 1)).toBe(true);
    expect(g.data.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});

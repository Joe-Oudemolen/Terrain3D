import { describe, expect, test } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import { clampParams } from '../../src/core/params';
import { runHydrology } from '../../src/hydro/hydrology';
import { assertNeverUphill, loadF32 } from '../helpers/synthetic';

const fixtures = [1, 2, 3].map((s) => loadF32(`tests/fixtures/eroded_s${s}_512.f32`, 512, 20));

describe('runHydrology', () => {
  test('all interior wet lakes on fixtures have a visible downstream outlet even at low rainfall', () => {
    for (const f of fixtures) {
      const h = runHydrology(f, clampParams({ rainfall: 0.05 }));
      for (const lake of h.lakes) {
        const x = lake.spill % f.width, z = Math.floor(lake.spill / f.width);
        if (h.lakeId[lake.spill] >= 0 || h.ocean[lake.spill] || x === 0 || z === 0 || x === f.width - 1 || z === f.height - 1) continue;
        expect(h.rivers.some(r => r.source.type === 'lake' && r.source.id === lake.id), `lake ${lake.id} at ${lake.surface} m needs an outlet`).toBe(true);
      }
      assertNeverUphill(h.rivers);
    }
  });
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
    const finite = (r: ReturnType<typeof runHydrology>) => {
      for (const a of [r.terrain.data, r.detailMask.data]) expect(a.every(Number.isFinite)).toBe(true);
      expect(r.detailMask.data.every((v) => v >= 0 && v <= 1)).toBe(true);
      for (const l of r.lakes) expect(Number.isFinite(l.surface)).toBe(true);
      for (const rv of r.rivers) for (const pt of rv.points) expect(Number.isFinite(pt.water)).toBe(true);
    };
    const f = fixtures[0];

    // rainfall 0: no rivers; lakes are not rainfall-driven, so only validity is asserted.
    const dry = runHydrology(f, clampParams({ rainfall: 0 }));
    expect(dry.rivers).toEqual([]);
    expect(Array.isArray(dry.lakes)).toBe(true);
    finite(dry);

    // mostly-ocean map: the real fixture lowered so nearly everything is at or below 0.
    let max = -Infinity;
    for (const v of f.data) max = Math.max(max, v);
    const sunk = makeGrid(f.width, f.cellSize);
    for (let i = 0; i < sunk.data.length; i++) sunk.data[i] = f.data[i] - max * 0.9;
    const sea = runHydrology(sunk, clampParams({ seaLevel: 0.5, mountainHeight: 100 }));
    let oceanCells = 0;
    for (const o of sea.ocean) oceanCells += o;
    expect(oceanCells / sea.ocean.length).toBeGreaterThan(0.5);
    expect(Array.isArray(sea.rivers)).toBe(true);
    expect(Array.isArray(sea.lakes)).toBe(true);
    finite(sea);

    // island on a tiny map
    for (const size of [16, 64]) {
      const tiny = runHydrology(makeGrid(size, 20), clampParams({ island: true }));
      expect(Array.isArray(tiny.rivers)).toBe(true);
      expect(Array.isArray(tiny.lakes)).toBe(true);
      finite(tiny);
    }

    // flat grid of zeros
    const flat = runHydrology(makeGrid(64, 20), clampParams({ flatland: 1 }));
    expect(flat.lakes).toEqual([]);
    expect(flat.rivers).toEqual([]);
    finite(flat);
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

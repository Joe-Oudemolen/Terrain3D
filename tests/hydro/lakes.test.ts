import { describe, expect, test } from 'vitest';
import type { Grid } from '../../src/core/grid';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { findLakes } from '../../src/hydro/lakes';
import { labelOcean, outletMask } from '../../src/hydro/ocean';
import { fillDepressions, fillEpsilon } from '../../src/hydro/priorityFlood';
import { bowlGrid, loadF32, pitGrid } from '../helpers/synthetic';

function run(g: Grid, p = DEFAULT_PARAMS) {
  const ocean = labelOcean(g);
  const filled = fillDepressions(g, outletMask(g, ocean));
  return { filled, ocean, ...findLakes(g, filled, ocean, p) };
}

describe('findLakes', () => {
  test('big deep bowl gives one lake with surface = rim spill', () => {
    const g = bowlGrid(100, 10, 100, 30);
    const { lakes, lakeId, filled } = run(g);
    expect(lakes).toHaveLength(1);
    const l = lakes[0];
    expect(l.surface).toBe(100);
    expect(filled[l.spill]).toBe(100);
    expect(g.data[l.spill]).toBe(100);
    expect(lakeId[50 * 100 + 50]).toBe(0);
    expect(lakeId[0]).toBe(-1);
    expect(l.cellCount).toBeGreaterThan(1000);
    expect(l.areaM2).toBe(l.cellCount * 100);
  });

  test('spill is the lowest rim cell, not just any rim cell', () => {
    // pit with one notch in its wall: the notch (lower rim) must be the spill... but the notch
    // also drains the pit, so the surface equals the notch height.
    const g = pitGrid(64, 10, 100, 10, 30);
    const c = 32;
    g.data[c * 64 + (c + 11)] = 90; // lower wall cell on the east side
    g.data[c * 64 + (c + 12)] = 90; // and a channel out of it
    for (let x = c + 13; x < 64; x++) g.data[c * 64 + x] = 90;
    const { lakes, filled } = run(g);
    expect(lakes).toHaveLength(1);
    expect(lakes[0].surface).toBe(90);
    expect(filled[lakes[0].spill]).toBe(90);
  });

  test('tiny pit is not a lake (minLakeSize)', () => {
    const g = pitGrid(64, 10, 100, 1, 20); // 9 cells = 900 m2 < 5000
    const { lakes, lakeId } = run(g);
    expect(lakes).toHaveLength(0);
    expect(lakeId.every((v) => v === -1)).toBe(true);
  });

  test('lakeFill 0 rejects a 1 m deep basin, lakeFill 1 accepts it', () => {
    const g = bowlGrid(100, 10, 100, 1);
    expect(run(g, { ...DEFAULT_PARAMS, lakeFill: 0 }).lakes).toHaveLength(0);
    expect(run(g, { ...DEFAULT_PARAMS, lakeFill: 1 }).lakes).toHaveLength(1);
  });

  test('lake bounds/outline in world meters', () => {
    // centre node (50,50) of a 101 grid at 10 m is (500,500) m
    const g = bowlGrid(101, 10, 100, 30);
    const l = run(g).lakes[0];
    expect(l.bounds.minX).toBeLessThan(500);
    expect(l.bounds.maxX).toBeGreaterThan(500);
    expect(l.bounds.minZ).toBeLessThan(500);
    expect(l.bounds.maxZ).toBeGreaterThan(500);
    expect(l.outline.length).toBeGreaterThan(8);
    for (const [x, z] of l.outline) {
      expect(x).toBeGreaterThanOrEqual(l.bounds.minX);
      expect(x).toBeLessThanOrEqual(l.bounds.maxX);
      expect(z).toBeGreaterThanOrEqual(l.bounds.minZ);
      expect(z).toBeLessThanOrEqual(l.bounds.maxZ);
    }
    // bowl radius is about 30 cells (300 m)
    const rs = l.outline.map(([x, z]) => Math.hypot(x - 500, z - 500));
    expect(Math.min(...rs)).toBeGreaterThan(250);
    expect(Math.max(...rs)).toBeLessThan(330);
  });

  test('outline of a square lake simplifies to a few vertices', () => {
    const g = pitGrid(100, 10, 100, 20, 30);
    const l = run(g).lakes[0];
    expect(l.outline.length).toBeGreaterThanOrEqual(4);
    expect(l.outline.length).toBeLessThanOrEqual(8);
  });

  test('ocean cells are never lakes', () => {
    const g = bowlGrid(100, 10, 100, 30);
    g.data.fill(-3);
    expect(run(g).lakes).toHaveLength(0);
  });

  test('deterministic', () => {
    const g = bowlGrid(100, 10, 100, 30);
    expect(run(g)).toEqual(run(g));
  });
});

describe('eroded fixtures', () => {
  test.each([1, 2, 3])('fixture s%i: strict drainage and sane lakes', (s) => {
    const g = loadF32(`tests/fixtures/eroded_s${s}_512.f32`, 512, 20);
    const ocean = labelOcean(g);
    const outlets = outletMask(g, ocean);
    const eps = fillEpsilon(g.data, g, outlets);
    let bad = 0;
    for (let z = 0; z < 512; z++) {
      for (let x = 0; x < 512; x++) {
        const i = z * 512 + x;
        if (!Number.isFinite(eps[i])) bad++;
        if (outlets[i]) continue;
        let lower = false;
        for (let dz = -1; dz <= 1 && !lower; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const nz = z + dz;
            if ((dx || dz) && nx >= 0 && nz >= 0 && nx < 512 && nz < 512 && eps[nz * 512 + nx] < eps[i]) {
              lower = true;
              break;
            }
          }
        }
        if (!lower) bad++;
      }
    }
    expect(bad).toBe(0);
    const filled = fillDepressions(g, outlets);
    const { lakes, lakeId } = findLakes(g, filled, ocean, DEFAULT_PARAMS);
    expect(lakeId).toHaveLength(512 * 512);
    for (const l of lakes) {
      expect(Number.isFinite(l.surface)).toBe(true);
      expect(l.spill).toBeGreaterThanOrEqual(0);
      expect(l.outline.length).toBeGreaterThanOrEqual(3);
      expect(l.outline.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z))).toBe(true);
    }
  });
});

import { describe, expect, test } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import { labelOcean, outletMask } from '../../src/hydro/ocean';

describe('labelOcean', () => {
  test('inland below-zero basin is not ocean', () => {
    const n = 20;
    const g = makeGrid(n, 10);
    g.data.fill(-5);
    for (let z = 4; z < 16; z++) for (let x = 4; x < 16; x++) g.data[z * n + x] = 10;
    for (let z = 7; z < 13; z++) for (let x = 7; x < 13; x++) g.data[z * n + x] = -5;
    const ocean = labelOcean(g);
    expect(ocean[10 * n + 10]).toBe(0);
    expect(ocean[0]).toBe(1);
    expect(ocean[2 * n + 2]).toBe(1);
    expect(ocean[10 * n + 5]).toBe(0);
  });

  test('connection is 4-connected only (diagonal gap does not leak)', () => {
    const g = makeGrid(5, 10);
    g.data.fill(10);
    g.data[0] = -1;
    g.data[1 * 5 + 1] = -1;
    const ocean = labelOcean(g);
    expect(ocean[0]).toBe(1);
    expect(ocean[1 * 5 + 1]).toBe(0);
  });

  test('outletMask is border plus ocean', () => {
    const g = makeGrid(6, 10);
    g.data.fill(5);
    g.data[2 * 6 + 0] = -1;
    g.data[2 * 6 + 1] = -1;
    const o = outletMask(g, labelOcean(g));
    expect(o[2 * 6 + 1]).toBe(1);
    expect(o[3 * 6 + 3]).toBe(0);
    expect(o[0]).toBe(1);
    expect(o[5 * 6 + 5]).toBe(1);
  });
});

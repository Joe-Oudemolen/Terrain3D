import { describe, expect, test } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import { MinHeap } from '../../src/hydro/heap';
import { labelOcean, outletMask } from '../../src/hydro/ocean';
import { fillDepressions, fillEpsilon } from '../../src/hydro/priorityFlood';
import { bowlGrid, valueNoiseGrid } from '../helpers/synthetic';

const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DZ = [-1, -1, -1, 0, 0, 1, 1, 1];

function expectStrictDrainage(f: Float32Array, w: number, h: number, outlets: Uint8Array) {
  let bad = 0;
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (outlets[i]) continue;
      let lower = false;
      for (let k = 0; k < 8 && !lower; k++) {
        const nx = x + DX[k];
        const nz = z + DZ[k];
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        if (f[nz * w + nx] < f[i]) lower = true;
      }
      if (!lower) bad++;
    }
  }
  expect(bad).toBe(0);
}

describe('MinHeap', () => {
  test('pops in key order, ties by smaller id', () => {
    const hp = new MinHeap(2);
    for (const [k, id] of [[3, 7], [1, 9], [1, 4], [2, 1], [3, 2], [0, 5]]) hp.push(k, id);
    const order: number[] = [];
    while (hp.size) order.push(hp.pop());
    expect(order).toEqual([5, 4, 9, 1, 2, 7]);
  });
});

describe('fillDepressions', () => {
  test('bowl fills to rim height', () => {
    const g = bowlGrid(64, 10, 100, 20);
    const filled = fillDepressions(g, outletMask(g, labelOcean(g)));
    expect(filled[32 * 64 + 32]).toBe(100);
    expect(filled[0]).toBe(100);
  });

  test('never lowers terrain and is pure', () => {
    const g = valueNoiseGrid(3, 64, 10, 50);
    const copy = g.data.slice();
    const f = fillDepressions(g, outletMask(g, labelOcean(g)));
    expect(g.data).toEqual(copy);
    for (let i = 0; i < f.length; i++) expect(f[i]).toBeGreaterThanOrEqual(g.data[i]);
  });
});

describe('fillEpsilon', () => {
  test('every non-outlet cell has a strictly lower 8-neighbour', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = valueNoiseGrid(seed, 64, 10, 100);
      const outlets = outletMask(g, labelOcean(g));
      expectStrictDrainage(fillEpsilon(g.data, g, outlets), 64, 64, outlets);
    }
  });

  test('never lowers terrain', () => {
    const g = valueNoiseGrid(5, 64, 10, 100);
    const outlets = outletMask(g, labelOcean(g));
    const out = fillEpsilon(g.data, g, outlets);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(g.data[i]);
  });

  test('large exact-flat region at 2000 m still drains (float32 precision)', () => {
    const g = makeGrid(300, 20);
    g.data.fill(2000);
    g.data[150 * 300 + 150] = 1990;
    for (let x = 0; x < 300; x++) g.data[x] = 1995;
    const outlets = outletMask(g, labelOcean(g));
    const out = fillEpsilon(g.data, g, outlets);
    expectStrictDrainage(out, 300, 300, outlets);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(g.data[i]);
  });

  test('still drains at 8000 m where eps is only a few float32 ulps', () => {
    const g = makeGrid(64, 20);
    g.data.fill(8000);
    const outlets = outletMask(g, labelOcean(g));
    expectStrictDrainage(fillEpsilon(g.data, g, outlets), 64, 64, outlets);
  });

  test('deterministic', () => {
    const g = valueNoiseGrid(7, 64, 10, 100);
    const outlets = outletMask(g, labelOcean(g));
    expect(fillEpsilon(g.data, g, outlets)).toEqual(fillEpsilon(g.data, g, outlets));
  });
});

import { describe, expect, test } from 'vitest';
import { makeGrid, type Grid } from '../../src/core/grid';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { flowAccumulation, flowReceivers, riverThreshold } from '../../src/hydro/flow';
import { labelOcean, outletMask } from '../../src/hydro/ocean';
import { fillEpsilon } from '../../src/hydro/priorityFlood';
import { valueNoiseGrid } from '../helpers/synthetic';

function route(g: Grid) {
  const outlets = outletMask(g, labelOcean(g));
  const surface = fillEpsilon(g.data, g, outlets);
  const receivers = flowReceivers(surface, g, outlets, new Int32Array(g.width * g.height).fill(-1), []);
  const acc = flowAccumulation(receivers, surface, g.cellSize * g.cellSize);
  return { outlets, surface, receivers, acc };
}

describe('flow', () => {
  test('accumulation on a tilted plane grows downslope', () => {
    const g = makeGrid(20, 10);
    for (let z = 0; z < 20; z++) for (let x = 0; x < 20; x++) g.data[z * 20 + x] = 100 + 2 * z;
    const { acc, receivers } = route(g);
    for (let z = 2; z < 18; z++) {
      expect(receivers[z * 20 + 10]).toBe((z - 1) * 20 + 10);
      expect(acc[(z - 1) * 20 + 10]).toBeGreaterThan(acc[z * 20 + 10]);
    }
    expect(acc[1 * 20 + 10]).toBe(18 * 100);
  });

  test('every receiver is strictly lower on the eps surface', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = valueNoiseGrid(seed, 48, 10, 50);
      const { receivers, surface, outlets } = route(g);
      for (let c = 0; c < receivers.length; c++) {
        if (outlets[c]) expect(receivers[c]).toBe(-1);
        else {
          expect(receivers[c]).toBeGreaterThanOrEqual(0);
          expect(surface[receivers[c]]).toBeLessThan(surface[c]);
        }
      }
    }
  });

  test('accumulation conserves area at outlets', () => {
    const g = valueNoiseGrid(3, 40, 10, 50);
    const { acc, receivers } = route(g);
    let total = 0;
    for (let c = 0; c < receivers.length; c++) if (receivers[c] < 0) total += acc[c];
    expect(total).toBeCloseTo(40 * 40 * 100, -2);
  });

  test('riverThreshold interpolates and is Infinity at rainfall 0', () => {
    expect(riverThreshold({ ...DEFAULT_PARAMS, rainfall: 0 })).toBe(Infinity);
    expect(riverThreshold({ ...DEFAULT_PARAMS, rainfall: 1 })).toBeCloseTo(0.15e6);
    expect(riverThreshold({ ...DEFAULT_PARAMS, rainfall: 0.5 })).toBeCloseTo(2.075e6);
  });
});

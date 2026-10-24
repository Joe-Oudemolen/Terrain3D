import { describe, expect, test } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import type { HydroResult } from '../../src/hydro/hydrology';
import { colorizeTerrain } from '../../src/ui/colorize';

function fakeHydro(n: number, g = makeGrid(n, 10)): HydroResult {
  return {
    terrain: g,
    lakes: [],
    rivers: [],
    ocean: new Uint8Array(n * n),
    lakeId: new Int32Array(n * n).fill(-1),
    detailMask: g,
  };
}
const px = (o: Uint8Array, i: number) => [...o.slice(i * 4, i * 4 + 4)];

describe('colorizeTerrain', () => {
  test('ocean cell gets ocean color, others grayscale by height', () => {
    const g = makeGrid(4, 10);
    g.data[5] = 100;
    const h = fakeHydro(4, g);
    h.ocean[0] = 1;
    const out = colorizeTerrain(g, h);
    expect(px(out, 0)).toEqual([0x1f, 0x4f, 0x86, 255]);
    expect(px(out, 5)).toEqual([255, 255, 255, 255]);
    expect(px(out, 1)).toEqual([0, 0, 0, 255]);
  });

  test('lake and river cells; showWater=false ignores hydro', () => {
    const g = makeGrid(8, 10);
    const h = fakeHydro(8, g);
    h.lakeId[0] = 2;
    h.rivers.push({
      id: 0,
      source: { type: 'spring' },
      outlet: { type: 'ocean' },
      points: [{ x: 50, z: 50, water: 0, width: 1, depth: 1, flow: 1 }],
    });
    const out = colorizeTerrain(g, h);
    expect(px(out, 0)).toEqual([0x2f, 0x6a, 0xa8, 255]);
    expect(px(out, 5 * 8 + 5)).toEqual([0x3d, 0x78, 0xb5, 255]);
    expect(px(out, 1)).toEqual([0, 0, 0, 255]);
    expect(px(colorizeTerrain(g, h, false), 0)).toEqual([0, 0, 0, 255]);
  });

  test('wide river covers neighbors within width/2', () => {
    const g = makeGrid(8, 10);
    const h = fakeHydro(8, g);
    h.rivers.push({
      id: 0,
      source: { type: 'spring' },
      outlet: { type: 'ocean' },
      points: [{ x: 40, z: 40, water: 0, width: 24, depth: 1, flow: 1 }],
    });
    const out = colorizeTerrain(g, h);
    expect(px(out, 4 * 8 + 5)).toEqual([0x3d, 0x78, 0xb5, 255]);
    expect(px(out, 4 * 8 + 7)).toEqual([0, 0, 0, 255]);
  });
});

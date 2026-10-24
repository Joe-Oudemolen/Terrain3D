import { describe, expect, test } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import { tileLayout } from '../../src/core/tiles';
import type { HydroResult } from '../../src/hydro/hydrology';
import type { River } from '../../src/hydro/riverGeometry';
import { buildRiverIndex } from '../../src/tile/riverIndex';
import { makeWaterLookup, waterMaskTile } from '../../src/tile/waterMask';

const L = tileLayout(2, 512);
const N = 512;

/** Ocean on cells x < 10; an inland lake (surface -2 m) on cells 20..40 x 20..40. */
function fakeHydro(): HydroResult {
  const terrain = makeGrid(N, 20);
  const lakeId = new Int32Array(N * N).fill(-1);
  const ocean = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      if (x < 10) ocean[z * N + x] = 1;
      else if (x >= 20 && x <= 40 && z >= 20 && z <= 40) lakeId[z * N + x] = 0;
    }
  }
  const lake = { id: 0, surface: -2 } as HydroResult['lakes'][number];
  return { terrain, lakes: [lake], rivers: [], ocean, lakeId, detailMask: terrain };
}

describe('waterMaskTile', () => {
  test('mask: river centre R=255, far away R=0, soft edge has intermediate values', () => {
    const river: River = {
      id: 0,
      points: [100, 500, 900].map((x) => ({ x, z: 600, water: 5, width: 8, depth: 2, flow: 1 })),
      source: { type: 'spring' } as never,
      outlet: { type: 'ocean' } as never,
    };
    const h = new Float32Array(N * N).fill(10);
    const m = waterMaskTile(h, L, 0, 0, buildRiverIndex([river]), makeWaterLookup(fakeHydro()));
    const row = 300; // z = 600 m
    expect(m[(row * N + 250) * 3]).toBe(255);
    expect(m[(10 * N + 250) * 3]).toBe(0);
    const across: number[] = [];
    for (let r = row - 6; r <= row + 6; r++) across.push(m[(r * N + 250) * 3]);
    expect(across.some((v) => v > 0 && v < 255)).toBe(true);
    expect(across[0]).toBe(0);
  });

  test('mask: inland below-zero lake is G not B; ocean is B', () => {
    const h = new Float32Array(N * N).fill(5);
    for (let r = 0; r < N; r++) for (let c = 0; c < 90; c++) h[r * N + c] = -3; // ocean floor, x < 180 m
    // Lake cells 20..40 -> 400..800 m -> pixels 200..400, bed below the -2 m surface.
    for (let r = 200; r <= 400; r++) for (let c = 200; c <= 400; c++) h[r * N + c] = -3.5;
    const m = waterMaskTile(h, L, 0, 0, buildRiverIndex([]), makeWaterLookup(fakeHydro()));
    const px = (c: number, r: number) => [m[(r * N + c) * 3], m[(r * N + c) * 3 + 1], m[(r * N + c) * 3 + 2]];
    expect(px(300, 300)).toEqual([0, 255, 0]);
    expect(px(20, 300)).toEqual([0, 0, 255]);
    // Dilated dry shore just outside the lake: surface known but terrain above it -> no water.
    expect(px(196, 300)).toEqual([0, 0, 0]);
    expect(px(450, 450)).toEqual([0, 0, 0]);
  });
});

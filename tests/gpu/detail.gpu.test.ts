import { afterAll, expect, test } from 'vitest';
import { makeGrid, type Grid } from '../../src/core/grid';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { sampleBicubic } from '../../src/core/sample';
import { tileLayout } from '../../src/core/tiles';
import { buildTileHeights, releaseTileCache } from '../../src/gpu/detail';
import { initGpu } from '../../src/gpu/device';

const ctx = await initGpu();
afterAll(() => releaseTileCache(ctx));

function baseTerrain(): Grid {
  const g = makeGrid(256, 40);
  for (let z = 0; z < 256; z++)
    for (let x = 0; x < 256; x++) g.data[z * 256 + x] = 300 * Math.sin(x * 0.07) * Math.cos(z * 0.05) + 0.3 * x;
  return g;
}
function mask(v: number): Grid {
  const m = makeGrid(128, 80);
  m.data.fill(v);
  return m;
}

test('matches CPU bicubic where detailMask = 0', async () => {
  const t = baseTerrain();
  const l = tileLayout(2, 512);
  const tx = 2;
  const tz = 3;
  const h = await buildTileHeights(ctx, t, mask(0), DEFAULT_PARAMS, l, tx, tz);
  expect(h.length).toBe(512 * 512);
  for (let r = 0; r < 512; r += 17)
    for (let c = 0; c < 512; c += 13) {
      const wx = (tx * 512 + c) * 2;
      const wz = (tz * 512 + r) * 2;
      expect(Math.abs(h[r * 512 + c] - sampleBicubic(t, wx, wz))).toBeLessThan(1e-3);
    }
});

test('detail adds bounded fine noise where mask = 1', async () => {
  const t = baseTerrain();
  const l = tileLayout(2, 512);
  const a = await buildTileHeights(ctx, t, mask(0), DEFAULT_PARAMS, l, 1, 1);
  const b = await buildTileHeights(ctx, t, mask(1), DEFAULT_PARAMS, l, 1, 1);
  let max = 0;
  let sq = 0;
  for (let i = 0; i < a.length; i++) {
    const d = b[i] - a[i];
    max = Math.max(max, Math.abs(d));
    sq += d * d;
  }
  expect(max).toBeGreaterThan(0.2);
  expect(max).toBeLessThan(4 * 1.5);
  expect(Math.sqrt(sq / a.length)).toBeGreaterThan(0.05);
});

test('seamless: adjacent tiles match a wider strip and continue smoothly', async () => {
  const t = baseTerrain();
  const m = mask(1);
  const small = tileLayout(2, 512);
  const wide = tileLayout(2, 1024);
  const a = await buildTileHeights(ctx, t, m, DEFAULT_PARAMS, small, 0, 0);
  const b = await buildTileHeights(ctx, t, m, DEFAULT_PARAMS, small, 1, 0);
  const w = await buildTileHeights(ctx, t, m, DEFAULT_PARAMS, wide, 0, 0);
  let maxStep = 0;
  for (let r = 0; r < 512; r++) {
    // Same world pixel, same value, independent of tiling.
    expect(Math.abs(a[r * 512 + 511] - w[r * 1024 + 511])).toBeLessThan(1e-3);
    expect(Math.abs(b[r * 512] - w[r * 1024 + 512])).toBeLessThan(1e-3);
    maxStep = Math.max(maxStep, Math.abs(w[r * 1024 + 512] - w[r * 1024 + 511]));
  }
  // The seam step is no bigger than steps elsewhere in the strip.
  let maxInner = 0;
  for (let r = 0; r < 512; r++)
    for (let c = 100; c < 400; c++)
      maxInner = Math.max(maxInner, Math.abs(w[r * 1024 + c + 1] - w[r * 1024 + c]));
  expect(maxStep).toBeLessThanOrEqual(maxInner + 1e-3);
});

test('deterministic, and seed changes detail', async () => {
  const t = baseTerrain();
  const m = mask(1);
  const l = tileLayout(2, 512);
  const a = await buildTileHeights(ctx, t, m, DEFAULT_PARAMS, l, 0, 0);
  const b = await buildTileHeights(ctx, t, m, DEFAULT_PARAMS, l, 0, 0);
  expect(a).toEqual(b);
  const c = await buildTileHeights(ctx, t, m, { ...DEFAULT_PARAMS, seed: DEFAULT_PARAMS.seed + 1 }, l, 0, 0);
  expect(c.some((v, i) => v !== a[i])).toBe(true);
});

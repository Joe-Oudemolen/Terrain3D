import { expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import type { Grid } from '../../src/core/grid';
import { DEFAULT_PARAMS, type TerrainParams } from '../../src/core/params';
import { initGpu } from '../../src/gpu/device';
import { erode } from '../../src/gpu/erosion';
import { generateTerrain } from '../../src/gpu/terrain';

const ctx = await initGpu();
const N = 256;
const base = await generateTerrain(ctx, DEFAULT_PARAMS, N);

const sum = (g: Grid) => g.data.reduce((s, v) => s + v, 0);

test('erode is deterministic and leaves the input untouched', async () => {
  const before = base.data.slice();
  const a = await erode(ctx, base, DEFAULT_PARAMS);
  const b = await erode(ctx, base, DEFAULT_PARAMS);
  expect(a).not.toBe(base);
  expect(a.data).toEqual(b.data);
  expect(base.data).toEqual(before);
  expect([a.width, a.height, a.cellSize]).toEqual([N, N, base.cellSize]);
});

test('erode changes terrain, produces no NaN', async () => {
  const out = await erode(ctx, base, DEFAULT_PARAMS);
  let diff = 0;
  for (let i = 0; i < out.data.length; i++) {
    expect(Number.isFinite(out.data[i])).toBe(true);
    diff += Math.abs(out.data[i] - base.data[i]);
  }
  expect(diff / out.data.length).toBeGreaterThan(0.1);
});

test('volume roughly conserved', async () => {
  const out = await erode(ctx, base, DEFAULT_PARAMS);
  const absBefore = base.data.reduce((s, v) => s + Math.abs(v), 0);
  expect(Math.abs(sum(out) - sum(base)) / absBefore).toBeLessThan(0.05);
});

test('progress is monotonic and ends at 1', async () => {
  const seen: number[] = [];
  await erode(ctx, base, DEFAULT_PARAMS, { onProgress: (f) => seen.push(f) });
  expect(seen.length).toBeGreaterThan(1);
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  expect(seen[seen.length - 1]).toBe(1);
});

test('abort rejects with AbortError within one chunk', async () => {
  const controller = new AbortController();
  const seen: number[] = [];
  const run = erode(ctx, base, DEFAULT_PARAMS, {
    signal: controller.signal,
    onProgress: (f) => {
      seen.push(f);
      controller.abort();
    },
  });
  await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBeLessThan(1);
});

test('island border still < 0 after erosion', async () => {
  const p: TerrainParams = { ...DEFAULT_PARAMS, island: true };
  const out = await erode(ctx, await generateTerrain(ctx, p, N), p);
  for (let i = 0; i < N; i++) {
    expect(out.data[i]).toBeLessThan(0);
    expect(out.data[(N - 1) * N + i]).toBeLessThan(0);
    expect(out.data[i * N]).toBeLessThan(0);
    expect(out.data[i * N + N - 1]).toBeLessThan(0);
  }
});

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

test.runIf(import.meta.env.VITE_CAPTURE_FIXTURES === '1')(
  'capture fixtures',
  async () => {
    for (const seed of [1, 2, 3]) {
      const p: TerrainParams = { ...DEFAULT_PARAMS, seed };
      const g = await erode(ctx, await generateTerrain(ctx, p, 512), p);
      expect(g.cellSize).toBe(20);
      // Float32Array is little-endian on every WebGPU-capable platform.
      const bytes = new Uint8Array(g.data.buffer, g.data.byteOffset, g.data.byteLength);
      await commands.writeFile(`tests/fixtures/eroded_s${seed}_512.f32`, toBase64(bytes), 'base64');
    }
  },
  120_000,
);

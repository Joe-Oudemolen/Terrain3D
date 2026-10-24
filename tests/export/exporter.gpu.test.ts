import { unzipSync } from 'fflate';
import { afterAll, expect, test } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/core/params';
import type { Grid } from '../../src/core/grid';
import { initGpu } from '../../src/gpu/device';
import { exportBundle } from '../../src/export/exporter';
import type { ByteSink } from '../../src/export/sink';
import { runHydrology } from '../../src/hydro/hydrology';
import fixtureUrl from '../fixtures/eroded_s1_512.f32?url';

const ctx = await initGpu();
afterAll(() => ctx.device.destroy());

const base: Grid = {
  width: 512,
  height: 512,
  cellSize: 20,
  data: new Float32Array(await (await fetch(fixtureUrl)).arrayBuffer()),
};
const P = { ...DEFAULT_PARAMS, outputSpacing: 2 as const, tileSize: 512 as const };
const hydro = runHydrology(base, P);
const TILES: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

function memorySink() {
  const chunks: Uint8Array[] = [];
  const events: string[] = [];
  const sink: ByteSink = {
    async write(c) {
      chunks.push(c);
    },
    async close() {
      events.push('close');
    },
    async abort() {
      events.push('abort');
    },
  };
  return { sink, chunks, events };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

test('zip contains expected files and unzips cleanly', async () => {
  const m = memorySink();
  const progress: number[] = [];
  await exportBundle(ctx, hydro, P, m.sink, { tiles: TILES, onProgress: (f) => progress.push(f) });
  expect(m.events).toEqual(['close']);
  expect(progress.at(-1)).toBe(1);
  const files = unzipSync(concat(m.chunks));
  expect(Object.keys(files).sort()).toEqual(
    [
      ...TILES.map(([x, z]) => `heights/height_x0${x}_z0${z}.exr`),
      ...TILES.map(([x, z]) => `water/water_x0${x}_z0${z}.png`),
      'world.json',
      'lakes.json',
      'rivers.json',
      'preset.txt',
      'README.txt',
      'godot/terrain3d_import.gd',
    ].sort(),
  );
  const world = JSON.parse(new TextDecoder().decode(files['world.json']));
  expect(world.tiles).toHaveLength(100);
  // EXR magic number, PNG signature.
  expect(Array.from(files['heights/height_x00_z00.exr'].slice(0, 4))).toEqual([0x76, 0x2f, 0x31, 0x01]);
  expect(Array.from(files['water/water_x00_z00.png'].slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
});

test('R16 export has a range and .r16 tiles of 2 bytes per pixel', async () => {
  const m = memorySink();
  await exportBundle(ctx, hydro, { ...P, heightFormat: 'r16' }, m.sink, { tiles: [[0, 0]] });
  const files = unzipSync(concat(m.chunks));
  expect(files['heights/height_x00_z00.r16'].length).toBe(512 * 512 * 2);
  const world = JSON.parse(new TextDecoder().decode(files['world.json']));
  expect(world.r16Range.max).toBeGreaterThan(world.r16Range.min);
});

test('abort aborts sink and rejects', async () => {
  const m = memorySink();
  const ac = new AbortController();
  const p = exportBundle(ctx, hydro, P, m.sink, { tiles: TILES, signal: ac.signal, onProgress: () => ac.abort() });
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  expect(m.events).toEqual(['abort']);
});

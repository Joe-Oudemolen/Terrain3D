import { expect, test } from 'vitest';
import {
  DEFAULT_PARAMS, PresetError, clampParams, decodePreset, encodePreset, loadSavedParams, saveParams,
} from '../../src/core/params';
import { makeGrid } from '../../src/core/grid';

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('preset round-trips', () => {
  const p = { ...DEFAULT_PARAMS, seed: 48213, island: true };
  expect(decodePreset(encodePreset(p))).toEqual(p);
});
test('clampParams clamps ranges and fixes tileSize 2048 at 2 m', () => {
  const p = clampParams({ mountainHeight: 99999, outputSpacing: 2, tileSize: 2048 });
  expect(p.mountainHeight).toBe(3000);
  expect(p.tileSize).toBe(1024);
});
test('decodePreset rejects garbage', () => {
  for (const s of ['', 'abc', btoa('{"v":99}'), btoa('not json')])
    expect(() => decodePreset(s)).toThrow(PresetError);
});
test('decodePreset fills missing fields from defaults', () => {
  const d = decodePreset(b64url({ v: 1, seed: 7 }));
  expect(d).toEqual({ ...DEFAULT_PARAMS, seed: 7 });
});
test('loadSavedParams survives throwing storage', () => {
  const bad = { getItem() { throw new Error('denied'); } } as unknown as Storage;
  const r = loadSavedParams(bad);
  expect(r.params).toEqual(DEFAULT_PARAMS);
  expect(r.warning).toBeDefined();
});
test('loadSavedParams with corrupt stored value gives defaults + warning', () => {
  const s = { getItem: () => '%%%' } as unknown as Storage;
  const r = loadSavedParams(s);
  expect(r.params).toEqual(DEFAULT_PARAMS);
  expect(r.warning).toBeDefined();
});
test('loadSavedParams with no storage or empty storage has no warning', () => {
  expect(loadSavedParams(null).warning).toBeUndefined();
  expect(loadSavedParams({ getItem: () => null } as unknown as Storage).warning).toBeUndefined();
});
test('saveParams then loadSavedParams round-trips; throwing storage is swallowed', () => {
  const m = new Map<string, string>();
  const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
  const p = { ...DEFAULT_PARAMS, seed: 99 };
  saveParams(p, st);
  expect(loadSavedParams(st).params).toEqual(p);
  const bad = { setItem() { throw new Error('quota'); } } as unknown as Storage;
  expect(() => saveParams(p, bad)).not.toThrow();
});
test('clampParams sanitizes bad values', () => {
  const p = clampParams({ seed: -5.5, ruggedness: NaN, baseQuality: 999 as never, heightFormat: 'png' as never });
  expect(p.seed).toBe(0);
  expect(p.ruggedness).toBe(DEFAULT_PARAMS.ruggedness);
  expect(p.baseQuality).toBe(2048);
  expect(p.heightFormat).toBe('exr');
});
test('makeGrid allocates size*size', () => {
  const g = makeGrid(4, 2560);
  expect(g.width).toBe(4);
  expect(g.height).toBe(4);
  expect(g.data.length).toBe(16);
});

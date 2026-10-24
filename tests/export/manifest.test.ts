import { expect, test } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { tileLayout } from '../../src/core/tiles';
import type { Lake } from '../../src/hydro/lakes';
import type { River } from '../../src/hydro/riverGeometry';
import { buildLakesJson, buildReadme, buildRiversJson, buildWorldJson } from '../../src/export/manifest';

test('world.json for 1 m/1024', () => {
  const w = buildWorldJson(DEFAULT_PARAMS, tileLayout(1, 1024), null);
  expect(w.tiles).toHaveLength(100);
  expect(w.tiles[13]).toEqual({ file: 'heights/height_x03_z01.exr', tx: 3, tz: 1, position: [3072, 0, 1024] });
  expect(w.waterMasks).toHaveLength(100);
  expect(w.waterMasks[13]).toBe('water/water_x03_z01.png');
  expect(w).toMatchObject({ version: 1, worldSizeM: 10240, vertexSpacing: 1, tileSize: 1024, tilesPerSide: 10, regionSize: 1024, heightFormat: 'exr', seaLevel: 0, r16Range: null, origin: [0, 0, 0] });
});

test('world.json for 2 m/512 R16 includes range', () => {
  const p = { ...DEFAULT_PARAMS, outputSpacing: 2 as const, tileSize: 512 as const, heightFormat: 'r16' as const };
  const w = buildWorldJson(p, tileLayout(2, 512), { min: -5, max: 900 });
  expect(w.tiles).toHaveLength(100);
  expect(w.tiles[11]).toEqual({ file: 'heights/height_x01_z01.r16', tx: 1, tz: 1, position: [1024, 0, 1024] });
  expect(w.vertexSpacing).toBe(2);
  expect(w.regionSize).toBe(512);
  expect(w.r16Range).toEqual({ min: -5, max: 900 });
});

test('lakes.json carries spill as [x,z] world meters', () => {
  const lake: Lake = {
    id: 2,
    surface: 12.5,
    cellCount: 4,
    spill: 3 * 512 + 7,
    bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 },
    areaM2: 1600,
    outline: [[0, 0], [10, 0], [10, 10]],
  };
  const j = buildLakesJson([lake], { width: 512, cellSize: 20 });
  expect(j.lakes[0]).toEqual({ id: 2, surface: 12.5, bounds: lake.bounds, areaM2: 1600, outline: lake.outline, spill: [140, 60] });
});

test('rivers.json points are [x,z,water,width,depth]', () => {
  const r: River = {
    id: 1,
    points: [
      { x: 1, z: 2, water: 3, width: 4, depth: 5, flow: 99 },
      { x: 6, z: 7, water: 8, width: 9, depth: 10, flow: 99 },
    ],
    source: { type: 'spring' },
    outlet: { type: 'river', id: 0, pointIndex: 3 },
  };
  const j = buildRiversJson([r]);
  expect(j.rivers[0]).toEqual({
    id: 1,
    source: { type: 'spring' },
    outlet: { type: 'river', id: 0, pointIndex: 3 },
    points: [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]],
  });
});

test('README mentions vertex spacing, region size, r16 range, Terrain3D version', () => {
  const p = { ...DEFAULT_PARAMS, heightFormat: 'r16' as const };
  const w = buildWorldJson(p, tileLayout(1, 1024), { min: -12, max: 1500 });
  const t = buildReadme(w, '1.2.3');
  expect(t).toContain('vertex_spacing');
  expect(t).toContain('region_size');
  expect(t).toContain('1024');
  expect(t).toContain('-12');
  expect(t).toContain('1500');
  expect(t).toContain('1.2.3');
});

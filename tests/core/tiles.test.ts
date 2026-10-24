import { expect, test } from 'vitest';
import { tileFileName, tileLayout, tileOrigin } from '../../src/core/tiles';

test('tileLayout 1m/1024 → 10x10', () => {
  expect(tileLayout(1, 1024)).toEqual({ spacing: 1, tileSize: 1024, pixels: 10240, tilesPerSide: 10 });
});
test('tileLayout 2m/2048 throws', () => {
  expect(() => tileLayout(2, 2048)).toThrow();
});
test('tileOrigin', () => {
  expect(tileOrigin(tileLayout(2, 512), 3, 1)).toEqual({ px0: 1536, pz0: 512, wx0: 3072, wz0: 1024 });
});
test('tileFileName zero-pads', () => {
  expect(tileFileName('height', 3, 7, 'exr')).toBe('heights/height_x03_z07.exr');
  expect(tileFileName('water', 3, 7, 'png')).toBe('water/water_x03_z07.png');
});

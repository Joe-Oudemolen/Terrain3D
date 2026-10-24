import { expect, test } from 'vitest';
import { worldToMinimap } from '../../src/ui/minimap';

test('minimap coordinates use the same corner and world meters as export', () => {
  expect(worldToMinimap(5120, 5120, 200)).toEqual([100, 100]);
  expect(worldToMinimap(0, 10240, 200)).toEqual([0, 200]);
});

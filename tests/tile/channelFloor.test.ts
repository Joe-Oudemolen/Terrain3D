import { expect, test } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import { tileLayout } from '../../src/core/tiles';
import type { River } from '../../src/hydro/riverGeometry';
import { buildChannelFloor } from '../../src/tile/channelFloor';
import { carveTile } from '../../src/tile/carve';
import { buildRiverIndex } from '../../src/tile/riverIndex';

test('a low upstream pixel drains across tile boundaries regardless of tile carving order', () => {
  const terrain = makeGrid(1024, 2); terrain.data.fill(20);
  terrain.data[50 * 1024 + 510] = 7.9;
  const river: River = { id: 0, source: { type: 'spring' }, outlet: { type: 'ocean' }, points: [1020, 1022, 1024, 1026].map((x, i) => ({ x, z: 100, water: 10 - i * 0.01, depth: 2, width: 6, flow: 100 })) };
  const layout = tileLayout(2, 512), index = buildRiverIndex([river]);
  const floor = buildChannelFloor(terrain, [river], layout, index);
  const tiles = [new Float32Array(512 * 512).fill(20), new Float32Array(512 * 512).fill(20)];
  tiles[0][50 * 512 + 510] = 7.9;
  for (const tx of [1, 0]) carveTile(tiles[tx], layout, tx, 0, index, floor);
  const values = [tiles[0][50 * 512 + 510], tiles[0][50 * 512 + 511], tiles[1][50 * 512], tiles[1][50 * 512 + 1]];
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1] + 1e-4);
  expect(Math.max(...values)).toBeLessThan(7.9);
});

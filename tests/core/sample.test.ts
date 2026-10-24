import { expect, test } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import { mulberry32 } from '../../src/core/rng';
import { sampleBicubic, sampleBilinear } from '../../src/core/sample';

test('bicubic reproduces grid values at nodes', () => {
  const g = makeGrid(8, 5);
  const r = mulberry32(1);
  for (let i = 0; i < g.data.length; i++) g.data[i] = r();
  for (let j = 0; j < 8; j++)
    for (let i = 0; i < 8; i++)
      expect(sampleBicubic(g, 5 * i, 5 * j)).toBeCloseTo(g.data[j * 8 + i], 5);
});

test('bicubic reproduces linear ramps exactly', () => {
  const g = makeGrid(8, 5);
  for (let j = 0; j < 8; j++)
    for (let i = 0; i < 8; i++) g.data[j * 8 + i] = 2 * (i * 5) + 3 * (j * 5);
  expect(sampleBicubic(g, 7.3, 11.9)).toBeCloseTo(2 * 7.3 + 3 * 11.9, 3);
});

test('bilinear reproduces linear ramps and nodes', () => {
  const g = makeGrid(8, 5);
  for (let j = 0; j < 8; j++)
    for (let i = 0; i < 8; i++) g.data[j * 8 + i] = 2 * (i * 5) + 3 * (j * 5);
  expect(sampleBilinear(g, 7.3, 11.9)).toBeCloseTo(2 * 7.3 + 3 * 11.9, 3);
  expect(sampleBilinear(g, 10, 15)).toBeCloseTo(65, 4);
});

test('clamps outside the grid', () => {
  const g = makeGrid(8, 5);
  const r = mulberry32(2);
  for (let i = 0; i < g.data.length; i++) g.data[i] = r();
  expect(sampleBicubic(g, -10, -10)).toBeCloseTo(g.data[0], 6);
  expect(sampleBilinear(g, -10, -10)).toBe(g.data[0]);
  expect(sampleBilinear(g, 1000, 1000)).toBe(g.data[63]);
});

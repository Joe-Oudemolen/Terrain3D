import { describe, expect, test } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import { clampIslandEdges } from '../../src/core/island';
import { DEFAULT_PARAMS } from '../../src/core/params';

function filled(size: number, v: number) {
  const g = makeGrid(size, 10);
  g.data.fill(v);
  return g;
}

describe('clampIslandEdges', () => {
  test('lowers only the border band when island', () => {
    const g = filled(100, 50);
    clampIslandEdges(g, { ...DEFAULT_PARAMS, island: true });
    const band = 3; // max(3, 2% of 100)
    expect(g.data[0]).toBe(-2);
    expect(g.data[2 * 100 + 50]).toBe(-2);
    expect(g.data[99 * 100 + 99]).toBe(-2);
    expect(g.data[band * 100 + 50]).toBe(50);
    expect(g.data[50 * 100 + band]).toBe(50);
    expect(g.data[50 * 100 + 50]).toBe(50);
  });
  test('band is 2% of width for large grids', () => {
    const g = filled(500, 10);
    clampIslandEdges(g, { ...DEFAULT_PARAMS, island: true });
    expect(g.data[9 * 500 + 250]).toBe(-2);
    expect(g.data[10 * 500 + 250]).toBe(10);
  });
  test('keeps values already below -2', () => {
    const g = filled(50, -30);
    clampIslandEdges(g, { ...DEFAULT_PARAMS, island: true });
    expect(g.data[0]).toBe(-30);
  });
  test('no-op when not island', () => {
    const g = filled(50, 10);
    clampIslandEdges(g, { ...DEFAULT_PARAMS, island: false });
    expect(g.data.every((v) => v === 10)).toBe(true);
  });
});

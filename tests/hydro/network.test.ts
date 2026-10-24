import { describe, expect, test } from 'vitest';
import { makeGrid, type Grid } from '../../src/core/grid';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { flowAccumulation, flowReceivers, riverThreshold } from '../../src/hydro/flow';
import { findLakes, type Lake } from '../../src/hydro/lakes';
import { extractNetwork } from '../../src/hydro/network';
import { labelOcean, outletMask } from '../../src/hydro/ocean';
import { fillDepressions, fillEpsilon } from '../../src/hydro/priorityFlood';
import { bowlGrid, loadF32 } from '../helpers/synthetic';

function pipeline(g: Grid, thresholdCells: number | null, p = DEFAULT_PARAMS) {
  const ocean = labelOcean(g);
  const outlets = outletMask(g, ocean);
  const plain = fillDepressions(g, outlets);
  const { lakeId, lakes } = findLakes(g, plain, ocean, p);
  const surface = fillEpsilon(g.data, g, outlets);
  const receivers = flowReceivers(surface, g, outlets, lakeId, lakes);
  const cs2 = g.cellSize * g.cellSize;
  const acc = flowAccumulation(receivers, surface, cs2, lakeId);
  const thr = thresholdCells === null ? riverThreshold(p) : thresholdCells * cs2;
  const paths = extractNetwork(g, receivers, acc, lakeId, lakes, ocean, thr);
  return { paths, receivers, acc, lakeId, lakes, ocean };
}

const S = 41;

function vValley(): Grid {
  const g = makeGrid(S, 100);
  for (let z = 0; z < S; z++)
    for (let x = 0; x < S; x++) g.data[z * S + x] = 100 + 2 * Math.abs(x - 20) + 0.5 * z;
  return g;
}

/** Main valley along x=20 (drains to z=0) with a tributary valley along z=25 for x>20. */
function tValley(): Grid {
  const g = makeGrid(S, 100);
  for (let z = 0; z < S; z++) {
    for (let x = 0; x < S; x++) {
      const main = 0.5 * z + 3 * Math.abs(x - 20);
      const trib = x >= 20 ? 12.5 + 0.5 * (x - 20) + 3 * Math.abs(z - 25) : Infinity;
      g.data[z * S + x] = 100 + Math.min(main, trib);
    }
  }
  return g;
}

function tiltedWithPit(): Grid {
  const n = 61;
  const g = makeGrid(n, 100);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) g.data[z * n + x] = 200 + 2 * z;
  for (let z = 25; z <= 35; z++) for (let x = 25; x <= 35; x++) g.data[z * n + x] -= 20;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) g.data[z * n + x] += 0.01 * x; // unique spill
  return g;
}

describe('extractNetwork', () => {
  test('no rivers when rainfall = 0', () => {
    const { paths } = pipeline(vValley(), null, { ...DEFAULT_PARAMS, rainfall: 0 });
    expect(paths).toEqual([]);
  });

  test('V-shaped valley gives one river along the valley floor', () => {
    const { paths } = pipeline(vValley(), 25);
    expect(paths).toHaveLength(1);
    const p = paths[0];
    expect(p.source.type).toBe('spring');
    expect(p.outlet.type).toBe('edge');
    for (const c of p.cells) expect(c % S).toBe(20);
    expect(p.cells[0]).toBe(39 * S + 20);
    expect(p.cells[p.cells.length - 1]).toBe(20);
    for (let k = 1; k < p.flow.length; k++) expect(p.flow[k]).toBeGreaterThan(p.flow[k - 1]);
  });

  test('T/Y-shaped valleys give a main river and one tributary joined at the junction', () => {
    const { paths, receivers } = pipeline(tValley(), 30);
    expect(paths).toHaveLength(2);
    const [main, trib] = paths;
    expect(main.id).toBe(0);
    expect(main.outlet.type).toBe('edge');
    expect(trib.outlet.type).toBe('river');
    if (trib.outlet.type !== 'river') throw new Error('unreachable');
    expect(trib.outlet.id).toBe(0);
    expect(trib.cells[trib.cells.length - 1]).toBe(main.cells[trib.outlet.pointIndex]);
    for (const p of paths)
      for (let k = 0; k + 1 < p.cells.length; k++) expect(receivers[p.cells[k]]).toBe(p.cells[k + 1]);
  });

  test('lake with enough inflow gets an outlet river starting at its spill', () => {
    // a perfectly flat rim has no unique spill (the epsilon flood leaves the lake everywhere), so tilt it
    const g = bowlGrid(100, 10, 100, 30);
    for (let z = 0; z < 100; z++) for (let x = 0; x < 100; x++) g.data[z * 100 + x] += 0.01 * x + 0.02 * z;
    const { paths, lakes, lakeId, receivers } = pipeline(g, 500);
    expect(lakes).toHaveLength(1);
    const out = paths.find((p) => p.source.type === 'lake');
    expect(out).toBeDefined();
    expect(out!.source).toEqual({ type: 'lake', id: 0 });
    // the river starts where a lake cell drains out of the lake
    expect(lakeId.some((id, c) => id === 0 && receivers[c] === out!.cells[0])).toBe(true);
    expect(lakeId[out!.cells[0]]).toBe(-1);
    expect(out!.outlet.type).toBe('edge');
  });

  test('flat-rim bowl gives exactly one outlet river starting at lake.spill', () => {
    const { paths, lakes, lakeId, receivers } = pipeline(bowlGrid(100, 10, 100, 30), 500);
    expect(lakes).toHaveLength(1);
    const outs = paths.filter((p) => p.source.type === 'lake');
    expect(outs).toHaveLength(1);
    expect(outs[0].cells[0]).toBe(lakes[0].spill);
    expect(receivers[lakes[0].spill]).toBeGreaterThanOrEqual(0);
    expect(lakeId[receivers[lakes[0].spill]]).toBe(-1);
    // every lake cell drains to the spill through lake cells only
    for (let c = 0; c < lakeId.length; c++) {
      if (lakeId[c] < 0) continue;
      let cur = c;
      let steps = 0;
      while (lakeId[cur] >= 0 && steps++ < lakeId.length) cur = receivers[cur];
      expect(cur).toBe(lakes[0].spill);
    }
  });

  test('lake outlet river starts at the spill even when a stream enters the spill from outside', () => {
    // 1-row chain: outside stream 0>1>2(spill)>3>edge; lake cells 5>4>spill
    const g = makeGrid(6, 1);
    g.height = 1;
    const receivers = Int32Array.from([1, 2, 3, -1, 2, 4]);
    const acc = Float32Array.from([1, 2, 6, 7, 2, 1]);
    const lakeId = Int32Array.from([-1, -1, -1, -1, 0, 0]);
    const lake = { id: 0, surface: 1, cellCount: 2, spill: 2, areaM2: 2 } as unknown as Lake;
    const paths = extractNetwork(g, receivers, acc, lakeId, [lake], new Uint8Array(6), 2);
    const lakeOut = paths.find((p) => p.source.type === 'lake')!;
    expect(lakeOut).toBeDefined();
    expect(lakeOut.cells).toEqual([2, 3]);
    const trib = paths.find((p) => p.source.type === 'spring')!;
    expect(trib.cells).toEqual([1, 2]);
    expect(trib.outlet).toEqual({ type: 'river', id: lakeOut.id, pointIndex: 0 });
    expect(paths).toHaveLength(2);
  });

  test('river into lake stops at first lake cell', () => {
    const { paths, lakeId, lakes } = pipeline(tiltedWithPit(), 10);
    expect(lakes).toHaveLength(1);
    const into = paths.filter((p) => p.outlet.type === 'lake');
    expect(into.length).toBeGreaterThan(0);
    for (const p of into) {
      expect(p.outlet).toEqual({ type: 'lake', id: 0 });
      expect(lakeId[p.cells[p.cells.length - 1]]).toBe(0);
      for (const c of p.cells.slice(0, -1)) expect(lakeId[c]).toBe(-1);
    }
    const out = paths.find((p) => p.source.type === 'lake');
    expect(out).toBeDefined();
    expect(out!.cells[0]).toBe(lakes[0].spill);
  });

  test('ids are ordered by decreasing mouth flow', () => {
    const { paths } = pipeline(tValley(), 30);
    paths.forEach((p, i) => expect(p.id).toBe(i));
  });

  test('every cell appears in at most one path except junction/lake/ocean cells', () => {
    const g = loadF32('tests/fixtures/eroded_s1_512.f32', 512, 20);
    const { paths, lakeId, ocean } = pipeline(g, 1000);
    expect(paths.length).toBeGreaterThan(1);
    const junctions = new Set<number>();
    for (const p of paths) if (p.outlet.type === 'river') junctions.add(p.cells[p.cells.length - 1]);
    const seen = new Set<number>();
    for (const p of paths) {
      for (const c of p.cells) {
        if (junctions.has(c) || lakeId[c] >= 0 || ocean[c]) continue;
        expect(seen.has(c)).toBe(false);
        seen.add(c);
      }
    }
  });

  test.each([1, 2, 3])('fixture %i smoke: rivers follow receivers at rainfall 0.5', (s) => {
    const g = loadF32(`tests/fixtures/eroded_s${s}_512.f32`, 512, 20);
    const { paths, receivers, lakes, lakeId } = pipeline(g, null);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    // a spill may drain into a different (downstream) lake, but never back into its own
    for (const l of lakes) expect(receivers[l.spill] < 0 || lakeId[receivers[l.spill]] !== l.id).toBe(true);
    const n = 512 * 512;
    for (const p of paths) {
      expect(p.cells.length).toBeGreaterThanOrEqual(2);
      for (const c of p.cells) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(n);
      }
      for (let k = 0; k + 1 < p.cells.length; k++) expect(receivers[p.cells[k]]).toBe(p.cells[k + 1]);
    }
  });
});

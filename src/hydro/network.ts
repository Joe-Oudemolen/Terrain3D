import type { Grid } from '../core/grid';
import type { Lake } from './lakes';

export type Endpoint =
  | { type: 'spring' }
  | { type: 'lake'; id: number }
  | { type: 'ocean' }
  | { type: 'edge' }
  | { type: 'river'; id: number; pointIndex: number };

export interface RiverPath {
  id: number;
  /** Cell indices, upstream to downstream. Follows receivers; the last cell may be a lake/ocean cell or a junction cell of another river. */
  cells: number[];
  /** Contributing area (m2) at each cell. */
  flow: number[];
  source: Endpoint;
  outlet: Endpoint;
}

interface RawPath {
  cells: number[];
  source: Endpoint;
  outlet: Endpoint;
  /** Cell whose index orders ties, and the flow of the path's own last cell. */
  mouthCell: number;
  mouthFlow: number;
  junction: number; // -1 unless outlet is a river
}

/**
 * Splits the drainage forest into river paths. A channel cell has acc >= threshold and is neither
 * lake nor ocean. The largest inflow continues the river at a confluence; the others become
 * tributaries ending at the junction cell (which they include as their last cell).
 */
export function extractNetwork(
  g: Grid,
  receivers: Int32Array,
  acc: Float32Array,
  lakeId: Int32Array,
  lakes: Lake[],
  ocean: Uint8Array,
  threshold: number,
): RiverPath[] {
  const n = g.width * g.height;
  if (!Number.isFinite(threshold)) return [];
  const isChannel = (c: number) => acc[c] >= threshold && lakeId[c] < 0 && !ocean[c];

  // Main (largest) channel inflow per cell; ascending scan keeps the lowest index on ties.
  const main = new Int32Array(n).fill(-1);
  for (let c = 0; c < n; c++) {
    if (!isChannel(c)) continue;
    const r = receivers[c];
    if (r < 0 || !isChannel(r)) continue;
    if (main[r] < 0 || acc[c] > acc[main[r]]) main[r] = c;
  }

  // Every lake exits exactly at lake.spill. The lake is treated as the spill's main inflow
  // (sentinel -2), so an outlet river starts there and outside channel inflows become tributaries.
  const spillLake = new Map<number, number>();
  for (const l of lakes) {
    if (!isChannel(l.spill) || spillLake.has(l.spill)) continue;
    spillLake.set(l.spill, l.id);
    main[l.spill] = -2;
  }

  const raw: RawPath[] = [];
  const cellPath = new Int32Array(n).fill(-1);
  const cellPos = new Int32Array(n);

  for (let head = 0; head < n; head++) {
    if (!isChannel(head) || main[head] >= 0) continue;
    const lid = spillLake.get(head);
    const cells: number[] = [head];
    const idx = raw.length;
    cellPath[head] = idx;
    cellPos[head] = 0;
    let cur = head;
    let outlet: Endpoint;
    let junction = -1;
    let mouthCell = head;
    for (;;) {
      const r = receivers[cur];
      if (r < 0) {
        outlet = { type: 'edge' };
        break;
      }
      if (ocean[r]) {
        cells.push(r);
        outlet = { type: 'ocean' };
        break;
      }
      if (lakeId[r] >= 0) {
        cells.push(r);
        outlet = { type: 'lake', id: lakeId[r] };
        break;
      }
      if (main[r] === cur) {
        cellPath[r] = idx;
        cellPos[r] = cells.length;
        cells.push(r);
        cur = r;
        mouthCell = r;
        continue;
      }
      cells.push(r);
      junction = r;
      outlet = { type: 'river', id: -1, pointIndex: -1 };
      break;
    }
    if (cells.length < 2) {
      cellPath[head] = -1;
      continue;
    }
    raw.push({
      cells,
      source: lid !== undefined ? { type: 'lake', id: lid } : { type: 'spring' },
      outlet,
      mouthCell,
      mouthFlow: acc[mouthCell],
      junction,
    });
  }

  const order = raw.map((_, i) => i);
  order.sort((a, b) => raw[b].mouthFlow - raw[a].mouthFlow || raw[a].mouthCell - raw[b].mouthCell);
  const newId = new Int32Array(raw.length);
  order.forEach((old, id) => (newId[old] = id));

  const paths: RiverPath[] = new Array(raw.length);
  for (const old of order) {
    const r = raw[old];
    let outlet = r.outlet;
    if (r.junction >= 0) {
      outlet = { type: 'river', id: newId[cellPath[r.junction]], pointIndex: cellPos[r.junction] };
    }
    paths[newId[old]] = {
      id: newId[old],
      cells: r.cells,
      flow: r.cells.map((c) => acc[c]),
      source: r.source,
      outlet,
    };
  }
  return paths;
}

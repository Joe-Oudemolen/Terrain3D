import type { Grid } from '../core/grid';
import type { TerrainParams } from '../core/params';
import { buildDetailMask } from './detailMask';
import { flowAccumulation, flowReceivers, resolveSpills, riverThreshold } from './flow';
import { findLakes, type Lake } from './lakes';
import { extractNetwork } from './network';
import { labelOcean, outletMask } from './ocean';
import { fillDepressions, fillEpsilon } from './priorityFlood';
import { buildRivers, type River } from './riverGeometry';

export interface HydroResult {
  /** Base after pit-filling: epsilon-filled outside lakes, original bed on lake cells. */
  terrain: Grid;
  lakes: Lake[];
  rivers: River[];
  ocean: Uint8Array;
  lakeId: Int32Array;
  /** Base-res, 1 = full detail, 0 = none (near rivers, in lakes/ocean). */
  detailMask: Grid;
}

/** Progress weights: flood 30%, lakes 10%, flow 30%, rivers 30%. */
export function runHydrology(
  g: Grid,
  p: TerrainParams,
  onProgress?: (f: number) => void,
  thresholdCells?: number,
): HydroResult {
  const report = (f: number) => onProgress?.(f);
  report(0);
  const ocean = labelOcean(g);
  const outlets = outletMask(g, ocean);
  const plain = fillDepressions(g, outlets);
  const surface = fillEpsilon(g.data, g, outlets);
  report(0.3);

  const { lakeId, lakes } = findLakes(g, plain, ocean, p);
  // Required: without it receivers can form cycles.
  resolveSpills(lakes, lakeId, surface, g);
  report(0.4);

  const cs2 = g.cellSize * g.cellSize;
  const receivers = flowReceivers(surface, g, outlets, lakeId, lakes);
  const acc = flowAccumulation(receivers, surface, cs2, lakeId);
  report(0.7);

  const thr = thresholdCells === undefined ? riverThreshold(p) : thresholdCells * cs2;
  const paths = extractNetwork(g, receivers, acc, lakeId, lakes, ocean, thr);
  const terrain: Grid = { width: g.width, height: g.height, cellSize: g.cellSize, data: new Float32Array(surface) };
  for (let c = 0; c < lakeId.length; c++) if (lakeId[c] >= 0) terrain.data[c] = g.data[c];
  const rivers = buildRivers(paths, terrain, lakes, p);
  const detailMask = buildDetailMask(g, rivers, lakeId, ocean);
  report(1);
  return { terrain, lakes, rivers, ocean, lakeId, detailMask };
}

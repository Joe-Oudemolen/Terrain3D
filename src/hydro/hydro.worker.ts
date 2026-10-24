import type { Grid } from '../core/grid';
import type { TerrainParams } from '../core/params';
import { runHydrology, type HydroResult } from './hydrology';

export interface HydroRequest {
  base: Grid;
  params: TerrainParams;
}

export type HydroMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; result: HydroResult }
  | { type: 'error'; message: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<HydroRequest>) => void) | null;
  postMessage(message: HydroMessage, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  try {
    const { base, params } = e.data;
    const result = runHydrology(base, params, (fraction) =>
      ctx.postMessage({ type: 'progress', fraction } satisfies HydroMessage),
    );
    const transfer = [
      result.terrain.data.buffer,
      result.detailMask.data.buffer,
      result.ocean.buffer,
      result.lakeId.buffer,
    ];
    ctx.postMessage({ type: 'done', result } satisfies HydroMessage, transfer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ type: 'error', message } satisfies HydroMessage);
  }
};

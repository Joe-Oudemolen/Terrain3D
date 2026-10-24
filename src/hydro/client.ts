import type { Grid } from '../core/grid';
import type { TerrainParams } from '../core/params';
import type { HydroMessage, HydroRequest } from './hydro.worker';
import type { HydroResult } from './hydrology';

/**
 * Runs hydrology in a module worker. A copy of `base.data` is transferred, so the caller's `base` is left untouched.
 * Aborting terminates the worker and rejects with an AbortError.
 */
export function runHydrologyInWorker(
  base: Grid,
  p: TerrainParams,
  signal?: AbortSignal,
  onProgress?: (f: number) => void,
): Promise<HydroResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Hydrology aborted', 'AbortError'));
      return;
    }
    const worker = new Worker(new URL('./hydro.worker.ts', import.meta.url), { type: 'module' });
    const onAbort = () => {
      worker.terminate();
      reject(new DOMException('Hydrology aborted', 'AbortError'));
    };
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<HydroMessage>) => {
      const m = e.data;
      if (m.type === 'progress') {
        onProgress?.(m.fraction);
      } else if (m.type === 'done') {
        finish();
        resolve(m.result);
      } else {
        finish();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || 'Hydrology worker failed'));
    };
    const copy: Grid = { ...base, data: base.data.slice() };
    const req: HydroRequest = { base: copy, params: p };
    try {
      worker.postMessage(req, [copy.data.buffer]);
    } catch (err) {
      finish();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

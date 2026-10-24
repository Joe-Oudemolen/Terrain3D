import { encodePreset, type TerrainParams } from '../core/params';
import { tileLayout } from '../core/tiles';
import type { GpuContext } from '../gpu/device';
import { buildTileHeights, DETAIL_PEAK, detailAmplitude, releaseTileCache } from '../gpu/detail';
import type { HydroResult } from '../hydro/hydrology';
import { buildChannelFloor } from '../tile/channelFloor';
import { buildRiverIndex } from '../tile/riverIndex';
import godotScript from '../../godot/terrain3d_import.gd?raw';
import type { ExportMessage, ExportRequest } from './export.worker';
import { buildLakesJson, buildReadme, buildRiversJson, buildWorldJson, TERRAIN3D_VERSION } from './manifest';
import { r16Range } from './r16';
import type { ByteSink } from './sink';

const MAX_IN_FLIGHT = 2;

export interface ExportOptions {
  signal?: AbortSignal;
  onProgress?: (f: number) => void;
  /** Test-only: restrict the export to these tiles. */
  tiles?: [number, number][];
}

/** Conservative R16 bound: lowest terrain minus the deepest channel and detail, highest plus detail. */
function conservativeR16Range(hydro: HydroResult, p: TerrainParams): { min: number; max: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of hydro.terrain.data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  let maxDepth = 0;
  for (const r of hydro.rivers) for (const q of r.points) if (q.depth > maxDepth) maxDepth = q.depth;
  const amp = detailAmplitude(p.ruggedness) * DETAIL_PEAK;
  // Bicubic upsampling can overshoot the base min/max near sharp peaks and pits.
  const overshoot = 0.1 * (hi - lo);
  return r16Range(lo - maxDepth - amp - overshoot, hi + amp + overshoot);
}

/**
 * Streams the export zip into `sink`. At most two tiles are in flight; the zip is produced in a worker
 * and written chunk by chunk, so memory stays bounded. On abort or failure the sink is aborted and the
 * promise rejects (AbortError for an abort).
 */
export async function exportBundle(
  ctx: GpuContext,
  hydro: HydroResult,
  p: TerrainParams,
  sink: ByteSink,
  opts: ExportOptions = {},
): Promise<{ clampedPixels: number }> {
  const { signal, onProgress } = opts;
  const l = tileLayout(p.outputSpacing, p.tileSize);
  const tiles: [number, number][] = opts.tiles ?? [];
  if (!opts.tiles) {
    for (let tz = 0; tz < l.tilesPerSide; tz++) for (let tx = 0; tx < l.tilesPerSide; tx++) tiles.push([tx, tz]);
  }
  const range = p.heightFormat === 'r16' ? conservativeR16Range(hydro, p) : null;

  let worker: Worker | undefined;
  let error: unknown = null;
  let inflight = 0;
  let completed = 0;
  let clampedPixels = 0;
  let finished = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const waitEvent = () => new Promise<void>((r) => (wake = r));
  const check = () => {
    if (error) throw error;
  };
  const fail = (e: unknown) => {
    error ??= e;
    notify();
  };
  const onAbort = () => fail(new DOMException('Export aborted', 'AbortError'));

  try {
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    check();

    // Messages are handled in order; sink writes are chained so tile-done never overtakes its chunks.
    let chain: Promise<void> = Promise.resolve();
    worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ExportMessage>) => {
      const m = e.data;
      if (m.type === 'chunk') {
        chain = chain.then(() => (error ? undefined : sink.write(m.data))).catch(fail);
      } else if (m.type === 'tile') {
        chain = chain
          .then(() => {
            inflight--;
            completed++;
            clampedPixels += m.clamped;
            onProgress?.(completed / (tiles.length + 1));
            notify();
          })
          .catch(fail);
      } else if (m.type === 'done') {
        chain = chain
          .then(() => {
            finished = true;
            notify();
          })
          .catch(fail);
      } else {
        fail(new Error(m.message));
      }
    };
    worker.onerror = (e) => fail(new Error(e.message || 'Export worker failed'));

    const init: ExportRequest = {
      type: 'init',
      channelFloor: [...buildChannelFloor(hydro.terrain, hydro.rivers, l, buildRiverIndex(hydro.rivers))],
      layout: l,
      format: p.heightFormat,
      r16: range,
      rivers: hydro.rivers,
      lakes: hydro.lakes,
      lakeId: hydro.lakeId,
      ocean: hydro.ocean,
      terrainDims: { width: hydro.terrain.width, height: hydro.terrain.height, cellSize: hydro.terrain.cellSize },
    };
    worker.postMessage(init);

    for (const [tx, tz] of tiles) {
      while (inflight >= MAX_IN_FLIGHT) {
        check();
        await waitEvent();
      }
      check();
      const heights = await buildTileHeights(ctx, hydro.terrain, hydro.detailMask, p, l, tx, tz);
      check();
      inflight++;
      worker.postMessage({ type: 'tile', tx, tz, heights } satisfies ExportRequest, [heights.buffer]);
    }
    while (inflight > 0) {
      check();
      await waitEvent();
    }

    const world = buildWorldJson(p, l, range);
    const files = [
      { name: 'world.json', text: JSON.stringify(world, null, 1) },
      { name: 'lakes.json', text: JSON.stringify(buildLakesJson(hydro.lakes, hydro.terrain)) },
      { name: 'rivers.json', text: JSON.stringify(buildRiversJson(hydro.rivers)) },
      { name: 'preset.txt', text: encodePreset(p) },
      { name: 'README.txt', text: buildReadme(world, TERRAIN3D_VERSION) },
      { name: 'godot/terrain3d_import.gd', text: godotScript },
    ];
    worker.postMessage({ type: 'finish', files } satisfies ExportRequest);
    while (!finished) {
      check();
      await waitEvent();
    }
    await chain;
    check();
    await sink.close();
    if (clampedPixels > 0) console.warn(`Export: ${clampedPixels} R16 pixels were clamped to the height range.`);
    onProgress?.(1);
    return { clampedPixels };
  } catch (e) {
    await sink.abort().catch(() => undefined);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    worker?.terminate();
    releaseTileCache(ctx);
  }
}

import type { Grid } from '../core/grid';
import type { TerrainParams } from '../core/params';
import type { ExportOptions } from '../export/exporter';
import type { ByteSink } from '../export/sink';
import type { GpuContext } from '../gpu/device';
import type { HydroResult } from '../hydro/hydrology';

export type PipelineState =
  | { kind: 'idle' }
  | { kind: 'busy'; task: 'preview' | 'generate' | 'export'; progress: number }
  | { kind: 'error'; message: string; retry: () => void };

export interface PipelineResult {
  kind: 'preview' | 'generate';
  base: Grid;
  hydro?: HydroResult;
  params: TerrainParams;
}

export interface PipelineDeps {
  initGpu: () => Promise<GpuContext>;
  generateTerrain: (ctx: GpuContext, p: TerrainParams, size: number) => Promise<Grid>;
  erode: (
    ctx: GpuContext,
    g: Grid,
    p: TerrainParams,
    opts?: { signal?: AbortSignal; onProgress?: (f: number) => void },
  ) => Promise<Grid>;
  runHydrologyInWorker: (
    base: Grid,
    p: TerrainParams,
    signal?: AbortSignal,
    onProgress?: (f: number) => void,
  ) => Promise<HydroResult>;
  openSaveSink: (suggestedName: string) => Promise<ByteSink | null>;
  exportBundle: (
    ctx: GpuContext,
    hydro: HydroResult,
    p: TerrainParams,
    sink: ByteSink,
    opts: ExportOptions,
  ) => Promise<{ clampedPixels: number }>;
}

export const PREVIEW_SIZE = 512;
export const PREVIEW_DEBOUNCE_MS = 120;
export const GPU_LOST_MESSAGE = 'GPU was reset. Click retry.';

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export class Pipeline {
  private ctx: GpuContext | null = null;
  private generation = 0;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: 'preview' | 'generate' | 'export' | null = null;
  private last: { params: TerrainParams; hydro: HydroResult } | null = null;
  private lastRequest: (() => Promise<void>) | null = null;
  private stateCbs: ((s: PipelineState) => void)[] = [];
  private resultCbs: ((r: PipelineResult) => void)[] = [];
  private noticeCbs: ((message: string) => void)[] = [];

  constructor(private deps: PipelineDeps) {}

  onState(cb: (s: PipelineState) => void): void {
    this.stateCbs.push(cb);
  }
  onResult(cb: (r: PipelineResult) => void): void {
    this.resultCbs.push(cb);
  }
  /** Non-fatal messages, e.g. clamped pixels after an export. */
  onNotice(cb: (message: string) => void): void {
    this.noticeCbs.push(cb);
  }

  preview(p: TerrainParams): void {
    if (this.busy === 'export') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.start('preview', p);
    }, PREVIEW_DEBOUNCE_MS);
  }

  generate(p: TerrainParams): Promise<void> {
    if (this.busy === 'export') return Promise.resolve();
    return this.start('generate', p);
  }

  /** Exports the last successful generate (its params and hydrology), not the current panel params. */
  async export(): Promise<void> {
    if (this.busy === 'generate' || this.busy === 'export' || !this.last) return;
    const { params, hydro } = this.last;
    const request = () => this.runExport(params, hydro);
    this.lastRequest = request;
    await request();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    if (this.busy) {
      this.busy = null;
      this.emit({ kind: 'idle' });
    }
  }

  private emit(s: PipelineState): void {
    for (const cb of this.stateCbs) cb(s);
  }

  private async getCtx(): Promise<GpuContext> {
    if (this.ctx) return this.ctx;
    const ctx = await this.deps.initGpu();
    this.ctx = ctx;
    void ctx.lost.then(() => this.onLost(ctx));
    return ctx;
  }

  private onLost(ctx: GpuContext): void {
    if (this.ctx !== ctx) return;
    this.ctx = null;
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.busy = null;
    const req = this.lastRequest;
    this.emit({ kind: 'error', message: GPU_LOST_MESSAGE, retry: () => void req?.() });
  }

  private fail(e: unknown, retry: () => Promise<void>): void {
    this.busy = null;
    this.abort = null;
    const message = e instanceof Error ? e.message : String(e);
    this.emit({ kind: 'error', message, retry: () => void retry() });
  }

  private async start(kind: 'preview' | 'generate', p: TerrainParams): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    const gen = ++this.generation;
    const ac = new AbortController();
    this.abort = ac;
    this.busy = kind;
    const request = () => this.start(kind, p);
    this.lastRequest = request;
    const stale = () => gen !== this.generation;
    const progress = (f: number) => {
      if (!stale()) this.emit({ kind: 'busy', task: kind, progress: Math.min(1, Math.max(0, f)) });
    };
    progress(0);
    try {
      const ctx = await this.getCtx();
      if (stale()) return;
      let result: PipelineResult;
      if (kind === 'preview') {
        const base = await this.deps.generateTerrain(ctx, p, PREVIEW_SIZE);
        result = { kind, base, params: p };
      } else {
        const terrain = await this.deps.generateTerrain(ctx, p, p.baseQuality);
        if (stale()) return;
        progress(0.05);
        const eroded = await this.deps.erode(ctx, terrain, p, {
          signal: ac.signal,
          onProgress: (f) => progress(0.05 + 0.7 * f),
        });
        if (stale()) return;
        progress(0.75);
        const hydro = await this.deps.runHydrologyInWorker(eroded, p, ac.signal, (f) => progress(0.75 + 0.25 * f));
        if (stale()) return;
        result = { kind, base: eroded, hydro, params: p };
        this.last = { params: p, hydro };
      }
      if (stale()) return;
      this.busy = null;
      this.abort = null;
      this.emit({ kind: 'idle' });
      for (const cb of this.resultCbs) cb(result);
    } catch (e) {
      if (stale() || isAbort(e)) return;
      this.fail(e, request);
    }
  }

  private async runExport(params: TerrainParams, hydro: HydroResult): Promise<void> {
    this.abort?.abort();
    const gen = ++this.generation;
    const ac = new AbortController();
    this.abort = ac;
    this.busy = 'export';
    const stale = () => gen !== this.generation;
    this.emit({ kind: 'busy', task: 'export', progress: 0 });
    try {
      const ctx = await this.getCtx();
      const sink = await this.deps.openSaveSink(`terrain_seed${params.seed}.zip`);
      if (stale()) return;
      if (!sink) {
        this.busy = null;
        this.abort = null;
        this.emit({ kind: 'idle' });
        return;
      }
      const { clampedPixels } = await this.deps.exportBundle(ctx, hydro, params, sink, {
        signal: ac.signal,
        onProgress: (f) => {
          if (!stale()) this.emit({ kind: 'busy', task: 'export', progress: f });
        },
      });
      if (stale()) return;
      this.busy = null;
      this.abort = null;
      this.emit({ kind: 'idle' });
      if (clampedPixels > 0) {
        for (const cb of this.noticeCbs) cb(`${clampedPixels} pixels were clamped to the height range.`);
      }
    } catch (e) {
      if (stale() || isAbort(e)) return;
      this.fail(e, () => this.runExport(params, hydro));
    }
  }
}

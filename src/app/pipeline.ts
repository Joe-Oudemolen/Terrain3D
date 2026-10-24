import type { Grid } from '../core/grid';
import { clampParams, type TerrainParams } from '../core/params';
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
export const DEFERRED_MESSAGE = 'Export in progress; changes will apply afterwards.';

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export class Pipeline {
  private ctx: GpuContext | null = null;
  private ctxPromise: Promise<GpuContext> | null = null;
  private generation = 0;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: 'preview' | 'generate' | 'export' | null = null;
  private last: { params: TerrainParams; hydro: HydroResult } | null = null;
  private lastRequest: (() => Promise<void>) | null = null;
  private deferred: { kind: 'preview' | 'generate'; p: TerrainParams } | null = null;
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
  /** Non-fatal messages, e.g. clamped pixels after an export or input deferred during one. */
  onNotice(cb: (message: string) => void): void {
    this.noticeCbs.push(cb);
  }

  preview(p: TerrainParams): void {
    const params = { ...p };
    if (this.busy === 'export') {
      this.defer('preview', params);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.busy === 'export') this.defer('preview', params);
      else void this.start('preview', params).catch(() => {});
    }, PREVIEW_DEBOUNCE_MS);
  }

  generate(p: TerrainParams): Promise<void> {
    const params = { ...p };
    if (this.busy === 'export') {
      this.defer('generate', params);
      return Promise.resolve();
    }
    return this.start('generate', params);
  }

  /** Exports the last successful generate (its params and hydrology), not the current panel params. */
  async export(output?: Pick<TerrainParams, 'outputSpacing' | 'tileSize' | 'heightFormat'>): Promise<void> {
    if (this.busy === 'generate' || this.busy === 'export' || !this.last) return;
    const { hydro } = this.last;
    const params = output ? clampParams({ ...this.last.params, outputSpacing: output.outputSpacing, tileSize: output.tileSize, heightFormat: output.heightFormat }) : this.last.params;
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
      const wasExport = this.busy === 'export';
      this.busy = null;
      this.emit({ kind: 'idle' });
      if (wasExport) this.flushDeferred();
    }
  }

  private emit(s: PipelineState): void {
    for (const cb of this.stateCbs) cb(s);
  }

  private notify(message: string): void {
    for (const cb of this.noticeCbs) cb(message);
  }

  private defer(kind: 'preview' | 'generate', p: TerrainParams): void {
    const first = !this.deferred;
    this.deferred = { kind: this.deferred?.kind === 'generate' ? 'generate' : kind, p };
    if (first) this.notify(DEFERRED_MESSAGE);
  }

  private flushDeferred(): void {
    const d = this.deferred;
    this.deferred = null;
    if (d) void this.start(d.kind, d.p).catch(() => {});
  }

  /** Single-flight: concurrent callers share one initGpu. */
  private getCtx(): Promise<GpuContext> {
    if (this.ctxPromise) return this.ctxPromise;
    const pr = this.deps.initGpu().then((ctx) => {
      this.ctx = ctx;
      void ctx.lost.then((info) => this.onLost(ctx, info));
      return ctx;
    });
    this.ctxPromise = pr;
    pr.catch(() => {
      if (this.ctxPromise === pr) this.ctxPromise = null;
    });
    return pr;
  }

  private onLost(ctx: GpuContext, info?: GPUDeviceLostInfo): void {
    if (this.ctx !== ctx) return;
    this.ctx = null;
    this.ctxPromise = null;
    if (info?.reason === 'destroyed') return;
    this.deferred = null;
    if (!this.busy) return; // idle: the next request re-inits
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

  /** A non-stale abort (e.g. from a dep) must not leave the pipeline busy. */
  private settleAbort(): void {
    const wasExport = this.busy === 'export';
    this.busy = null;
    this.abort = null;
    this.emit({ kind: 'idle' });
    if (wasExport) this.flushDeferred();
  }

  private async start(kind: 'preview' | 'generate', p: TerrainParams): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deferred = null;
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
    let result: PipelineResult;
    try {
      const ctx = await this.getCtx();
      if (stale()) return;
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
    } catch (e) {
      if (stale()) return;
      if (isAbort(e)) this.settleAbort();
      else this.fail(e, request);
      return;
    }
    for (const cb of this.resultCbs) cb(result);
  }

  private async runExport(params: TerrainParams, hydro: HydroResult): Promise<void> {
    this.abort?.abort();
    const gen = ++this.generation;
    const ac = new AbortController();
    this.abort = ac;
    this.busy = 'export';
    const stale = () => gen !== this.generation;
    this.emit({ kind: 'busy', task: 'export', progress: 0 });
    let clamped = 0;
    try {
      const ctx = await this.getCtx();
      if (stale()) return;
      const sink = await this.deps.openSaveSink(`terrain_seed${params.seed}.zip`);
      if (stale()) {
        await sink?.abort().catch(() => {});
        return;
      }
      if (!sink) {
        this.busy = null;
        this.abort = null;
        this.emit({ kind: 'idle' });
        this.flushDeferred();
        return;
      }
      const res = await this.deps.exportBundle(ctx, hydro, params, sink, {
        signal: ac.signal,
        onProgress: (f) => {
          if (!stale()) this.emit({ kind: 'busy', task: 'export', progress: f });
        },
      });
      clamped = res.clampedPixels;
      if (stale()) return;
      this.busy = null;
      this.abort = null;
      this.emit({ kind: 'idle' });
    } catch (e) {
      if (stale()) return;
      if (isAbort(e)) this.settleAbort();
      else {
        this.deferred = null; // keep the error and retry visible
        this.fail(e, () => this.runExport(params, hydro));
      }
      return;
    }
    if (clamped > 0) this.notify(`${clamped} pixels were clamped to the height range.`);
    this.flushDeferred();
  }
}

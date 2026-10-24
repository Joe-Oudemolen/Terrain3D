import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeGrid } from '../../src/core/grid';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { Pipeline, type PipelineDeps, type PipelineResult, type PipelineState } from '../../src/app/pipeline';
import type { HydroResult } from '../../src/hydro/hydrology';

const P = DEFAULT_PARAMS;
const abortErr = () => new DOMException('aborted', 'AbortError');

function fakeHydro(g = makeGrid(4, 10)): HydroResult {
  return { terrain: g, lakes: [], rivers: [], ocean: new Uint8Array(16), lakeId: new Int32Array(16), detailMask: g };
}

interface Rig {
  pl: Pipeline;
  states: PipelineState[];
  results: PipelineResult[];
  lost: () => void;
  calls: { gen: number; init: number; hydro: number; exp: number };
}

function rig(genDelay = 50, over: Partial<PipelineDeps> = {}): Rig {
  const calls = { gen: 0, init: 0, hydro: 0, exp: 0 };
  let lostResolve!: (v: GPUDeviceLostInfo) => void;
  const delay = (ms: number) => (ms === 0 ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms)));
  const deps: PipelineDeps = {
    initGpu: async () => {
      calls.init++;
      const lost = new Promise<GPUDeviceLostInfo>((r) => (lostResolve = r));
      return { device: {} as GPUDevice, lost };
    },
    generateTerrain: async (_c, p, size) => {
      calls.gen++;
      await delay(genDelay);
      const g = makeGrid(4, 10);
      g.data[0] = p.seed + size;
      return g;
    },
    erode: async (_c, g, _p, o) => {
      o?.onProgress?.(1);
      return g;
    },
    runHydrologyInWorker: async (b) => {
      calls.hydro++;
      return fakeHydro(b);
    },
    openSaveSink: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
    exportBundle: async () => {
      calls.exp++;
      return { clampedPixels: 0 };
    },
    ...over,
  };
  const pl = new Pipeline(deps);
  const states: PipelineState[] = [];
  const results: PipelineResult[] = [];
  pl.onState((s) => states.push(s));
  pl.onResult((r) => results.push(r));
  return { pl, states, results, lost: () => lostResolve({} as GPUDeviceLostInfo), calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Pipeline', () => {
  test('export uses current output options but retains the generated terrain parameters', async () => {
    let exported: typeof P | undefined;
    const r = rig(0, { exportBundle: async (_ctx, _hydro, p) => { exported = p; return { clampedPixels: 0 }; } });
    await r.pl.generate({ ...P, seed: 7 });
    const current: typeof P = { ...P, seed: 99, outputSpacing: 2, tileSize: 512, heightFormat: 'r16' };
    await r.pl.export(current);
    expect(exported).toMatchObject({ seed: 7, outputSpacing: 2, tileSize: 512, heightFormat: 'r16' });
  });
  test('latest request wins', async () => {
    const r = rig();
    const a = r.pl.generate({ ...P, seed: 1 });
    await vi.advanceTimersByTimeAsync(10);
    const b = r.pl.generate({ ...P, seed: 2 });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([a, b]);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].params.seed).toBe(2);
    expect(r.results[0].kind).toBe('generate');
    expect(r.results[0].hydro).toBeDefined();
    expect(r.states.at(-1)).toEqual({ kind: 'idle' });
  });

  test('starting a new run aborts the in-flight signal', async () => {
    let first: AbortSignal | undefined;
    const r = rig(0, {
      erode: async (_c, g, _p, o) => {
        first ??= o?.signal;
        await new Promise((res) => setTimeout(res, 50));
        return g;
      },
    });
    void r.pl.generate({ ...P, seed: 1 });
    await vi.advanceTimersByTimeAsync(10);
    void r.pl.generate({ ...P, seed: 2 });
    expect(first?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(r.results.map((x) => x.params.seed)).toEqual([2]);
  });

  test('preview is debounced and uses size 512 without hydro', async () => {
    const r = rig(0);
    for (let i = 0; i < 5; i++) {
      r.pl.preview({ ...P, seed: 10 + i });
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(r.calls.gen).toBe(1);
    expect(r.calls.hydro).toBe(0);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].kind).toBe('preview');
    expect(r.results[0].base.data[0]).toBe(14 + 512);
  });

  test('generate reports monotonic progress through the stages', async () => {
    const r = rig(0);
    await r.pl.generate(P);
    const progress = r.states.flatMap((s) => (s.kind === 'busy' ? [s.progress] : []));
    expect(progress[0]).toBe(0);
    expect(progress).toContain(0.75);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1])).toBe(true);
  });

  test('export without generate is refused', async () => {
    const r = rig(0);
    await r.pl.export();
    expect(r.calls.exp).toBe(0);
    expect(r.states).toHaveLength(0);
  });

  test('export uses params of last generate and reports clamped pixels', async () => {
    let usedSeed = -1;
    let name = '';
    const r = rig(0, {
      openSaveSink: async (n) => {
        name = n;
        return { write: async () => {}, close: async () => {}, abort: async () => {} };
      },
      exportBundle: async (_c, _h, p) => {
        usedSeed = p.seed;
        return { clampedPixels: 3 };
      },
    });
    const notes: string[] = [];
    r.pl.onNotice((m) => notes.push(m));
    await r.pl.generate({ ...P, seed: 7 });
    await r.pl.export();
    expect(usedSeed).toBe(7);
    expect(name).toBe('terrain_seed7.zip');
    expect(notes).toHaveLength(1);
    expect(r.states.at(-1)).toEqual({ kind: 'idle' });
  });

  test('export is refused while generate is busy', async () => {
    const r = rig(10);
    const first = r.pl.generate(P);
    await vi.advanceTimersByTimeAsync(50);
    await first;
    const second = r.pl.generate(P);
    await r.pl.export();
    expect(r.calls.exp).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    await second;
  });

  test('export with dismissed picker returns to idle, no error', async () => {
    const r = rig(0, { openSaveSink: async () => null });
    await r.pl.generate(P);
    await r.pl.export();
    expect(r.calls.exp).toBe(0);
    expect(r.states.some((s) => s.kind === 'error')).toBe(false);
    expect(r.states.at(-1)).toEqual({ kind: 'idle' });
  });

  test('device lost -> error state, recoverable', async () => {
    const r = rig(50);
    const g = r.pl.generate(P);
    await vi.advanceTimersByTimeAsync(10);
    r.lost();
    await vi.advanceTimersByTimeAsync(100);
    await g;
    const err = r.states.at(-1);
    expect(err?.kind).toBe('error');
    if (err?.kind !== 'error') throw new Error('expected error state');
    expect(err.message).toBe('GPU was reset. Click retry.');
    expect(r.results).toHaveLength(0);
    err.retry();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.calls.init).toBe(2);
    expect(r.results).toHaveLength(1);
    expect(r.states.at(-1)).toEqual({ kind: 'idle' });
  });

  test('erosion AbortError is not surfaced as an error', async () => {
    const r = rig(0, {
      erode: async () => {
        throw abortErr();
      },
    });
    await r.pl.generate(P);
    expect(r.states.some((s) => s.kind === 'error')).toBe(false);
    expect(r.results).toHaveLength(0);
    expect(r.states.at(-1)).toEqual({ kind: 'idle' });
  });

  test('real failure becomes error state with retry', async () => {
    let fail = true;
    const r = rig(0, {
      runHydrologyInWorker: async (b) => {
        if (fail) throw new Error('boom');
        return fakeHydro(b);
      },
    });
    await r.pl.generate(P);
    const err = r.states.at(-1);
    expect(err).toMatchObject({ kind: 'error', message: 'boom' });
    fail = false;
    if (err?.kind === 'error') err.retry();
    await vi.advanceTimersByTimeAsync(10);
    expect(r.results).toHaveLength(1);
  });

  test('concurrent requests share a single initGpu', async () => {
    let inits = 0;
    const r = rig(0, {
      initGpu: async () => {
        inits++;
        await new Promise((res) => setTimeout(res, 30));
        return { device: {} as GPUDevice, lost: new Promise<GPUDeviceLostInfo>(() => {}) };
      },
    });
    void r.pl.generate(P);
    void r.pl.generate({ ...P, seed: 2 });
    await vi.advanceTimersByTimeAsync(100);
    expect(inits).toBe(1);
    expect(r.results).toHaveLength(1);
  });

  test('device lost while idle is silent and the next request re-inits', async () => {
    const r = rig(0);
    await r.pl.generate(P);
    const n = r.states.length;
    r.lost();
    await vi.advanceTimersByTimeAsync(10);
    expect(r.states).toHaveLength(n);
    await r.pl.generate(P);
    expect(r.calls.init).toBe(2);
    expect(r.results).toHaveLength(2);
  });

  test('device lost during export -> error, retry re-runs export', async () => {
    let first = true;
    const r = rig(0, {
      exportBundle: async () => {
        if (first) {
          first = false;
          await new Promise((res) => setTimeout(res, 50));
        }
        return { clampedPixels: 0 };
      },
    });
    await r.pl.generate(P);
    const e = r.pl.export();
    await vi.advanceTimersByTimeAsync(10);
    r.lost();
    await vi.advanceTimersByTimeAsync(100);
    await e;
    const err = r.states.at(-1);
    expect(err).toMatchObject({ kind: 'error', message: 'GPU was reset. Click retry.' });
    if (err?.kind === 'error') err.retry();
    await vi.advanceTimersByTimeAsync(10);
    expect(r.calls.init).toBe(2);
    expect(r.states.at(-1)).toEqual({ kind: 'idle' });
  });

  test('a pending preview timer does not kill an export; it is deferred and runs afterwards', async () => {
    let aborted = false;
    const r = rig(0, {
      exportBundle: async (_c, _h, _p, _s, o) => {
        await new Promise((res) => setTimeout(res, 300));
        aborted = !!o.signal?.aborted;
        return { clampedPixels: 0 };
      },
    });
    const notes: string[] = [];
    r.pl.onNotice((m) => notes.push(m));
    await r.pl.generate({ ...P, seed: 1 });
    r.pl.preview({ ...P, seed: 5 });
    const e = r.pl.export();
    await vi.advanceTimersByTimeAsync(200); // timer fires mid-export
    expect(r.results).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await e;
    expect(aborted).toBe(false);
    expect(notes).toEqual(['Export in progress; changes will apply afterwards.']);
    await vi.advanceTimersByTimeAsync(10);
    expect(r.results.map((x) => [x.kind, x.params.seed])).toEqual([
      ['generate', 1],
      ['preview', 5],
    ]);
  });

  test('generate during export is deferred and runs after the export', async () => {
    const r = rig(0, {
      exportBundle: async () => {
        await new Promise((res) => setTimeout(res, 50));
        return { clampedPixels: 0 };
      },
    });
    await r.pl.generate({ ...P, seed: 1 });
    const e = r.pl.export();
    await vi.advanceTimersByTimeAsync(5);
    await r.pl.generate({ ...P, seed: 2 });
    r.pl.preview({ ...P, seed: 3 });
    expect(r.results).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await e;
    await vi.advanceTimersByTimeAsync(10);
    expect(r.results.map((x) => [x.kind, x.params.seed])).toEqual([
      ['generate', 1],
      ['generate', 3],
    ]);
  });

  test('deferred input is dropped on device lost; no stale replay after a fresh request', async () => {
    let slow = true;
    const r = rig(0, {
      exportBundle: async () => {
        if (slow) {
          slow = false;
          await new Promise((res) => setTimeout(res, 50));
        }
        return { clampedPixels: 0 };
      },
    });
    await r.pl.generate({ ...P, seed: 1 });
    const e = r.pl.export();
    await vi.advanceTimersByTimeAsync(5);
    r.pl.preview({ ...P, seed: 9 }); // deferred
    r.lost();
    await vi.advanceTimersByTimeAsync(100);
    await e;
    await r.pl.generate({ ...P, seed: 2 });
    await r.pl.export();
    await vi.advanceTimersByTimeAsync(10);
    expect(r.results.map((x) => [x.kind, x.params.seed])).toEqual([
      ['generate', 1],
      ['generate', 2],
    ]);
  });

  test('export error with deferred input keeps the error visible and does not replay', async () => {
    const r = rig(0, {
      exportBundle: async () => {
        await new Promise((res) => setTimeout(res, 20));
        throw new Error('disk full');
      },
    });
    await r.pl.generate({ ...P, seed: 1 });
    const e = r.pl.export();
    await vi.advanceTimersByTimeAsync(5);
    r.pl.preview({ ...P, seed: 9 });
    await vi.advanceTimersByTimeAsync(50);
    await e;
    await vi.advanceTimersByTimeAsync(200);
    expect(r.states.at(-1)).toMatchObject({ kind: 'error', message: 'disk full' });
    expect(r.results).toHaveLength(1);
  });

  test('sink is aborted when the run goes stale after the picker', async () => {
    let aborted = 0;
    let release!: () => void;
    const r = rig(0, {
      openSaveSink: () =>
        new Promise((res) => {
          release = () =>
            res({ write: async () => {}, close: async () => {}, abort: async () => void aborted++ });
        }),
    });
    await r.pl.generate(P);
    const e = r.pl.export();
    await vi.advanceTimersByTimeAsync(5);
    r.pl.cancel();
    release();
    await vi.advanceTimersByTimeAsync(5);
    await e;
    expect(aborted).toBe(1);
    expect(r.calls.exp).toBe(0);
  });

  test('a throwing result listener is not a pipeline error', async () => {
    const r = rig(0);
    r.pl.onResult(() => {
      throw new Error('listener');
    });
    await expect(r.pl.generate(P)).rejects.toThrow('listener');
    expect(r.states.some((s) => s.kind === 'error')).toBe(false);
    expect(r.states.at(-1)).toEqual({ kind: 'idle' });
  });

  test('cancel aborts and returns to idle', async () => {
    const r = rig(50);
    void r.pl.generate(P);
    await vi.advanceTimersByTimeAsync(10);
    r.pl.cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.results).toHaveLength(0);
    expect(r.states.at(-1)).toEqual({ kind: 'idle' });
  });
});

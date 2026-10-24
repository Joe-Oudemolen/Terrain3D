import type { Grid } from '../core/grid';
import { clampIslandEdges } from '../core/island';
import type { TerrainParams } from '../core/params';
import { createStorage, readback } from './buffers';
import type { GpuContext } from './device';
import erosionSrc from './wgsl/erosion.wgsl?raw';
import thermalSrc from './wgsl/thermal.wgsl?raw';

const CHUNK = 50;
const THERMAL_EVERY = 5;
const G = 9.81;

// Physical constants (SI units). dt and the pipe area A scale with the cell size l, so the
// wave CFL number (dt^2 * A * g / l^3 = 0.12) is the same at every resolution, while the
// step count scales with 1/l. Total simulated time and all rates are therefore resolution
// independent: 512, 2048 and 4096 give the same landforms at map scale.
const DT_PER_M = 0.05; // dt = 0.05 s per meter of cell size
const PIPE_DEPTH = 5; // A = PIPE_DEPTH * l
const RAIN = 0.03; // m/s
const EVAPORATION = 0.002; // 1/s
const DEPTH_REF = 5; // m
const KC = 5;
const KS = 0.05; // 1/s
const MIN_SIN = 0.02;
const D_MIN = 0.01; // m
const MAX_ERODE_PER_M = 0.02; // max incision per step, as a fraction of l
const THERMAL_RATE = 0.5;

interface Pipelines {
  flux: GPUComputePipeline;
  water: GPUComputePipeline;
  erode: GPUComputePipeline;
  advect: GPUComputePipeline;
  outflow: GPUComputePipeline;
  apply: GPUComputePipeline;
}

const pipelineCache = new WeakMap<GPUDevice, Promise<Pipelines>>();

async function buildPipelines(device: GPUDevice): Promise<Pipelines> {
  device.pushErrorScope('validation');
  const hydro = device.createShaderModule({ code: erosionSrc });
  const thermal = device.createShaderModule({ code: thermalSrc });
  const make = (module: GPUShaderModule, entryPoint: string) =>
    device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
  const pls: Pipelines = {
    flux: make(hydro, 'flux'),
    water: make(hydro, 'waterStep'),
    erode: make(hydro, 'erodeStep'),
    advect: make(hydro, 'advect'),
    outflow: make(thermal, 'outflow'),
    apply: make(thermal, 'apply'),
  };
  const err = await device.popErrorScope();
  if (err) throw new Error(`Erosion shader failed to compile: ${err.message}`);
  return pls;
}

function getPipelines(device: GPUDevice): Promise<Pipelines> {
  let p = pipelineCache.get(device);
  if (!p) {
    p = buildPipelines(device);
    pipelineCache.set(device, p);
    p.catch(() => pipelineCache.delete(device));
  }
  return p;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function abortError(): DOMException {
  return new DOMException('Erosion was cancelled', 'AbortError');
}

/** Hydraulic (virtual pipe) + thermal erosion on the GPU. Returns a new Grid; `g` is untouched. */
export async function erode(
  ctx: GpuContext,
  g: Grid,
  p: TerrainParams,
  opts: { signal?: AbortSignal; onProgress?: (f: number) => void } = {},
): Promise<Grid> {
  const { signal, onProgress } = opts;
  if (signal?.aborted) throw abortError();
  const { device } = ctx;
  const pls = await getPipelines(device);
  if (signal?.aborted) throw abortError();
  const n = g.width;
  const cells = n * n;
  const l = g.cellSize;
  const dt = DT_PER_M * l;
  const totalSteps = Math.max(1, Math.round(lerp(300, 3000, p.erosionDuration) * (n / 2048)));

  const hydroU = new ArrayBuffer(64);
  const hu32 = new Uint32Array(hydroU);
  const hf32 = new Float32Array(hydroU);
  hu32[0] = n;
  hf32[1] = l;
  hf32[2] = dt;
  hf32[3] = dt * PIPE_DEPTH * G; // dt * A * g / l
  hf32[4] = RAIN * dt;
  hf32[5] = 1 - EVAPORATION * dt;
  hf32[6] = KC * 2 * p.erosionStrength; // default strength 0.5 -> KC
  hf32[7] = KS * dt;
  hf32[8] = lerp(0.002, 0.03, p.sedimentDeposition) * dt;
  hf32[9] = DEPTH_REF;
  hf32[11] = MIN_SIN;
  hf32[12] = D_MIN;
  hf32[13] = MAX_ERODE_PER_M * l;
  // Hillslope diffusivity D in m^2/s; D*dt/l^2 <= 0.2 stays stable even at 4096 (l = 2.5 m).
  hf32[14] = (10 * p.thermalSmoothing * dt) / (l * l);

  const thermalU = new ArrayBuffer(16);
  new Uint32Array(thermalU)[0] = n;
  const tf32 = new Float32Array(thermalU);
  tf32[1] = l;
  tf32[2] = lerp(0.9, 0.35, p.thermalSmoothing); // talus slope: 42 deg .. 19 deg
  tf32[3] = THERMAL_RATE * p.thermalSmoothing;

  const buffers: GPUBuffer[] = [];
  const track = (b: GPUBuffer) => (buffers.push(b), b);
  try {
    const uniform = (data: ArrayBuffer) => {
      const b = track(device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const hu = uniform(hydroU);
    const tu = uniform(thermalU);
    const terrain = [track(createStorage(ctx, g.data)), track(createStorage(ctx, cells))];
    const sed = [track(createStorage(ctx, cells)), track(createStorage(ctx, cells))];
    const water = track(createStorage(ctx, cells));
    const [fL, fR, fT, fB, speed, wPrev, ratio] = Array.from({ length: 7 }, () => track(createStorage(ctx, cells)));

    const bind = (pl: GPUComputePipeline, entries: Record<number, GPUBuffer>) =>
      device.createBindGroup({
        layout: pl.getBindGroupLayout(0),
        entries: Object.entries(entries).map(([k, buffer]) => ({ binding: Number(k), resource: { buffer } })),
      });
    const flux = [0, 1].map((t) =>
      bind(pls.flux, { 0: hu, 1: terrain[t], 3: water, 6: fL, 7: fR, 8: fT, 9: fB }),
    );
    const waterBg = bind(pls.water, { 0: hu, 3: water, 6: fL, 7: fR, 8: fT, 9: fB, 10: speed, 11: wPrev });
    const erodeBg = [0, 1].map((t) =>
      [0, 1].map((s) =>
        bind(pls.erode, { 0: hu, 1: terrain[t], 2: terrain[1 - t], 3: water, 4: sed[s], 10: speed }),
      ),
    );
    const advectBg = [0, 1].map((s) =>
      bind(pls.advect, { 0: hu, 3: water, 4: sed[s], 5: sed[1 - s], 6: fL, 7: fR, 8: fT, 9: fB, 11: wPrev }),
    );
    const outflowBg = [0, 1].map((t) => bind(pls.outflow, { 0: tu, 1: terrain[t], 3: ratio }));
    const applyBg = [0, 1].map((t) => bind(pls.apply, { 0: tu, 1: terrain[t], 2: terrain[1 - t], 3: ratio }));

    const groups = Math.ceil(n / 8);
    let t = 0; // index of the current terrain buffer
    let s = 0; // index of the current sediment buffer
    for (let done = 0; done < totalSteps; ) {
      const end = Math.min(totalSteps, done + CHUNK);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      const run = (pl: GPUComputePipeline, bg: GPUBindGroup) => {
        pass.setPipeline(pl);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(groups, groups);
      };
      for (; done < end; done++) {
        run(pls.flux, flux[t]);
        run(pls.water, waterBg);
        run(pls.erode, erodeBg[t][s]);
        t = 1 - t;
        run(pls.advect, advectBg[s]);
        s = 1 - s;
        if ((done + 1) % THERMAL_EVERY === 0) {
          run(pls.outflow, outflowBg[t]);
          run(pls.apply, applyBg[t]);
          t = 1 - t;
        }
      }
      pass.end();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      onProgress?.(done / totalSteps);
      if (signal?.aborted) throw abortError();
    }

    // Suspended sediment settles where it is when the simulation stops.
    const [bOut, sOut] = await Promise.all([readback(ctx, terrain[t], cells), readback(ctx, sed[s], cells)]);
    for (let i = 0; i < cells; i++) bOut[i] += sOut[i];
    const out: Grid = { width: g.width, height: g.height, cellSize: g.cellSize, data: bOut };
    clampIslandEdges(out, p);
    return out;
  } finally {
    for (const b of buffers) b.destroy();
  }
}

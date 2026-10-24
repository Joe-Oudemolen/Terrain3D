import { WORLD_SIZE_M, makeGrid, type Grid } from '../core/grid';
import { clampIslandEdges } from '../core/island';
import type { TerrainParams } from '../core/params';
import { deriveSeed, mulberry32 } from '../core/rng';
import { createStorage, readback } from './buffers';
import type { GpuContext } from './device';
import commonSrc from './wgsl/common.wgsl?raw';
import terrainSrc from './wgsl/terrain.wgsl?raw';

const pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();

function getPipeline(device: GPUDevice): GPUComputePipeline {
  let pl = pipelines.get(device);
  if (!pl) {
    const module = device.createShaderModule({ code: commonSrc + '\n' + terrainSrc });
    pl = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    pipelines.set(device, pl);
  }
  return pl;
}

/** Base heightmap in meters with sea level at 0. Shape depends on world meters only, not on `size`. */
export async function generateTerrain(ctx: GpuContext, p: TerrainParams, size: number): Promise<Grid> {
  const { device } = ctx;
  const cell = WORLD_SIZE_M / size;
  const seed = deriveSeed(p.seed, 'terrain');
  const rnd = mulberry32(seed);
  const buf = new ArrayBuffer(64);
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  u32[0] = size;
  u32[1] = seed;
  f32[2] = cell;
  f32[3] = WORLD_SIZE_M;
  f32[4] = rnd() * 1000; // noise-space offset x
  f32[5] = rnd() * 1000; // noise-space offset y
  f32[6] = p.featureScale * 1000; // larger km values mean broader features
  f32[7] = 0.24 + 0.24 * p.ruggedness; // fine relief decays quickly in the lowlands
  f32[8] = p.ridgeSharpness;
  f32[9] = 1 + 2 * p.flatland;
  f32[10] = p.seaLevel;
  f32[11] = p.mountainHeight;
  u32[12] = p.island ? 1 : 0;
  f32[13] = p.coastlineWidth * 1000;

  const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniform, 0, buf);
  const out = createStorage(ctx, size * size);
  const pl = getPipeline(device);
  const bind = device.createBindGroup({
    layout: pl.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: out } },
    ],
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pl);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
  pass.end();
  device.queue.submit([enc.finish()]);

  const g = makeGrid(size, cell);
  g.data.set(await readback(ctx, out, size * size));
  uniform.destroy();
  out.destroy();
  clampIslandEdges(g, p);
  return g;
}

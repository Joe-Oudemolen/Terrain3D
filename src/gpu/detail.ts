import type { Grid } from '../core/grid';
import type { TerrainParams } from '../core/params';
import { deriveSeed } from '../core/rng';
import { tileOrigin, type TileLayout } from '../core/tiles';
import { createStorage, readback } from './buffers';
import type { GpuContext } from './device';
import commonSrc from './wgsl/common.wgsl?raw';
import detailSrc from './wgsl/detail.wgsl?raw';

const pipelines = new WeakMap<GPUDevice, Promise<GPUComputePipeline>>();

async function buildPipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: commonSrc + '\n' + detailSrc });
  const pl = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const err = await device.popErrorScope();
  if (err) throw new Error(`Detail shader failed to compile: ${err.message}`);
  return pl;
}

function getPipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  let p = pipelines.get(device);
  if (!p) {
    p = buildPipeline(device);
    pipelines.set(device, p);
    p.catch(() => pipelines.delete(device));
  }
  return p;
}

/**
 * Base grids are uploaded once and reused for every tile of an export. Ownership: this module owns
 * the buffers. They are destroyed when a different grid of the same kind is uploaded (so repeated
 * Generate runs do not leak) or by `releaseTileCache` (call it when an export finishes or fails).
 */
interface Slot {
  grids: WeakMap<Grid, GPUBuffer>;
  current?: { grid: Grid; buf: GPUBuffer };
}
interface DeviceCache {
  terrain: Slot;
  mask: Slot;
}
const caches = new WeakMap<GPUDevice, DeviceCache>();

function cacheFor(device: GPUDevice): DeviceCache {
  let c = caches.get(device);
  if (!c) {
    c = { terrain: { grids: new WeakMap() }, mask: { grids: new WeakMap() } };
    caches.set(device, c);
  }
  return c;
}

function upload(ctx: GpuContext, slot: Slot, g: Grid): GPUBuffer {
  let buf = slot.grids.get(g);
  if (buf) return buf;
  if (slot.current) {
    slot.current.buf.destroy();
    slot.grids.delete(slot.current.grid);
  }
  buf = createStorage(ctx, g.data);
  slot.grids.set(g, buf);
  slot.current = { grid: g, buf };
  return buf;
}

/** Destroys the cached base-grid buffers for this device. */
export function releaseTileCache(ctx: GpuContext): void {
  const c = caches.get(ctx.device);
  if (!c) return;
  for (const slot of [c.terrain, c.mask]) {
    if (slot.current) {
      slot.current.buf.destroy();
      slot.grids.delete(slot.current.grid);
      slot.current = undefined;
    }
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Full-res heights (meters, tileSize^2, row-major) for tile (tx, tz): bicubic base terrain plus
 * world-space fBm detail weighted by the bilinear detailMask.
 */
export async function buildTileHeights(
  ctx: GpuContext,
  terrain: Grid,
  detailMask: Grid,
  p: TerrainParams,
  l: TileLayout,
  tx: number,
  tz: number,
): Promise<Float32Array> {
  const { device } = ctx;
  const pl = await getPipeline(device);
  const cache = cacheFor(device);
  const tBuf = upload(ctx, cache.terrain, terrain);
  const mBuf = upload(ctx, cache.mask, detailMask);
  const { wx0, wz0 } = tileOrigin(l, tx, tz);
  const n = l.tileSize * l.tileSize;

  const raw = new ArrayBuffer(48);
  const u32 = new Uint32Array(raw);
  const i32 = new Int32Array(raw);
  const f32 = new Float32Array(raw);
  u32[0] = l.tileSize;
  u32[1] = deriveSeed(p.seed, 'detail');
  i32[2] = terrain.width;
  i32[3] = terrain.height;
  i32[4] = detailMask.width;
  i32[5] = detailMask.height;
  f32[6] = terrain.cellSize;
  f32[7] = detailMask.cellSize;
  f32[8] = wx0;
  f32[9] = wz0;
  f32[10] = l.spacing;
  f32[11] = lerp(0.5, 4, p.ruggedness);

  const uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const out = createStorage(ctx, n);
  try {
    device.queue.writeBuffer(uniform, 0, raw);
    const bind = device.createBindGroup({
      layout: pl.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: tBuf } },
        { binding: 2, resource: { buffer: mBuf } },
        { binding: 3, resource: { buffer: out } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pl);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(l.tileSize / 8), Math.ceil(l.tileSize / 8));
    pass.end();
    device.queue.submit([enc.finish()]);
    return await readback(ctx, out, n);
  } finally {
    uniform.destroy();
    out.destroy();
  }
}

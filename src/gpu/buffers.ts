import type { GpuContext } from './device';

const USAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

/** Storage buffer initialised from data, or zero-filled with `src` elements when a number. */
export function createStorage(ctx: GpuContext, src: Float32Array | number): GPUBuffer {
  const length = typeof src === 'number' ? src : src.length;
  const buf = ctx.device.createBuffer({ size: Math.max(4, length * 4), usage: USAGE });
  if (typeof src !== 'number') ctx.device.queue.writeBuffer(buf, 0, src as Float32Array<ArrayBuffer>);
  return buf;
}

export async function readback(ctx: GpuContext, buf: GPUBuffer, length: number): Promise<Float32Array> {
  const { device } = ctx;
  const bytes = length * 4;
  const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buf, 0, staging, 0, bytes);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}

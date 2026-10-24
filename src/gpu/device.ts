export interface GpuContext {
  device: GPUDevice;
  lost: Promise<GPUDeviceLostInfo>;
}

export class WebGpuUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebGpuUnavailableError';
  }
}

export async function initGpu(): Promise<GpuContext> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new WebGpuUnavailableError('WebGPU is not available in this browser.');
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new WebGpuUnavailableError('No WebGPU adapter was found.');
  const device = await adapter.requestDevice();
  return { device, lost: device.lost };
}

import { expect, test } from 'vitest';
import { createStorage, readback } from '../../src/gpu/buffers';
import { initGpu } from '../../src/gpu/device';
import { generateTerrain } from '../../src/gpu/terrain';
import { makeGrid } from '../../src/core/grid';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { sampleBicubic, sampleBilinear } from '../../src/core/sample';
import commonSrc from '../../src/gpu/wgsl/common.wgsl?raw';

const ctx = await initGpu();

test('default hills are dominated by broad landforms rather than pixel-scale ridges', async () => {
  const g = await generateTerrain(ctx, DEFAULT_PARAMS, 256);
  let lap = 0, count = 0, lo = Infinity, hi = -Infinity;
  for (const h of g.data) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  for (let z = 1; z < 255; z++) for (let x = 1; x < 255; x++) {
    const i = z * 256 + x;
    lap += Math.abs(g.data[i] - (g.data[i - 1] + g.data[i + 1] + g.data[i - 256] + g.data[i + 256]) / 4); count++;
  }
  expect(lap / count / (hi - lo)).toBeLessThan(0.0012);
});

test('larger feature scale produces broader terrain features', async () => {
  const slope = (g: ReturnType<typeof makeGrid>) => {
    let sum = 0;
    for (let z = 0; z < g.height - 1; z++) for (let x = 0; x < g.width - 1; x++) {
      const i = z * g.width + x; sum += Math.abs(g.data[i + 1] - g.data[i]) + Math.abs(g.data[i + g.width] - g.data[i]);
    }
    return sum / g.data.length;
  };
  const small = await generateTerrain(ctx, { ...DEFAULT_PARAMS, featureScale: 1 }, 256);
  const large = await generateTerrain(ctx, { ...DEFAULT_PARAMS, featureScale: 8 }, 256);
  expect(slope(large)).toBeLessThan(slope(small) * 0.5);
});

test('same seed gives identical heights', async () => {
  const a = await generateTerrain(ctx, DEFAULT_PARAMS, 256);
  const b = await generateTerrain(ctx, DEFAULT_PARAMS, 256);
  expect(a.data).toEqual(b.data);
});

test('different seed gives different heights', async () => {
  const a = await generateTerrain(ctx, { ...DEFAULT_PARAMS, seed: 1 }, 256);
  const b = await generateTerrain(ctx, { ...DEFAULT_PARAMS, seed: 2 }, 256);
  expect(a.data.some((v, i) => v !== b.data[i])).toBe(true);
});

test('cellSize and finite range', async () => {
  const g = await generateTerrain(ctx, DEFAULT_PARAMS, 256);
  expect(g.cellSize).toBe(40);
  let min = Infinity;
  let max = -Infinity;
  for (const v of g.data) {
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(DEFAULT_PARAMS.mountainHeight);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  expect(max - min).toBeGreaterThan(100); // real relief, not a flat field
});

test('island: all border cells below 0', async () => {
  const n = 256;
  for (const coastlineWidth of [0.2, 1]) {
    const g = await generateTerrain(ctx, { ...DEFAULT_PARAMS, island: true, coastlineWidth }, n);
    for (let i = 0; i < n; i++) {
      expect(g.data[i]).toBeLessThan(0);
      expect(g.data[(n - 1) * n + i]).toBeLessThan(0);
      expect(g.data[i * n]).toBeLessThan(0);
      expect(g.data[i * n + n - 1]).toBeLessThan(0);
    }
  }
});

test('preview and base agree in shape', async () => {
  const lo = await generateTerrain(ctx, DEFAULT_PARAMS, 128);
  const hi = await generateTerrain(ctx, DEFAULT_PARAMS, 512);
  const a: number[] = [];
  const b: number[] = [];
  for (let z = 0; z < 128; z++) {
    for (let x = 0; x < 128; x++) {
      a.push(lo.data[z * 128 + x]);
      b.push(sampleBilinear(hi, x * lo.cellSize, z * lo.cellSize));
    }
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  expect(sab / Math.sqrt(saa * sbb)).toBeGreaterThan(0.95);
});

test('WGSL bicubic matches CPU sampleBicubic', async () => {
  const g = makeGrid(16, 40);
  for (let i = 0; i < g.data.length; i++) g.data[i] = Math.sin(i * 0.7) * 50 + (i % 5) * 10;
  const pts: [number, number][] = [];
  for (let k = 0; k < 64; k++) pts.push([-80 + k * 11.3, 700 - k * 12.9]);
  const pbuf = new Float32Array(pts.flat());
  const code =
    commonSrc +
    `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> pts: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> res: array<f32>;
@compute @workgroup_size(8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ${pts.length}u) { return; }
  res[id.x] = bicubic(&src, 16, 16, 40.0, pts[id.x]);
}`;
  const module = ctx.device.createShaderModule({ code });
  const pl = ctx.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const res = createStorage(ctx, pts.length);
  const bind = ctx.device.createBindGroup({
    layout: pl.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: createStorage(ctx, g.data) } },
      { binding: 1, resource: { buffer: createStorage(ctx, pbuf) } },
      { binding: 2, resource: { buffer: res } },
    ],
  });
  const enc = ctx.device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pl);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(Math.ceil(pts.length / 8));
  pass.end();
  ctx.device.queue.submit([enc.finish()]);
  const out = await readback(ctx, res, pts.length);
  pts.forEach(([x, z], i) => expect(out[i]).toBeCloseTo(sampleBicubic(g, x, z), 2));
});

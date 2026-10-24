import { expect, test } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/core/params';
import type { Grid } from '../../src/core/grid';
import { initGpu } from '../../src/gpu/device';
import { generateTerrain } from '../../src/gpu/terrain';
import { erode } from '../../src/gpu/erosion';
import { runHydrologyInWorker } from '../../src/hydro/client';

function mediumRelief(g: Grid): number {
  const step = Math.round(160 / g.cellSize);
  let sum = 0, count = 0, lo = Infinity, hi = -Infinity;
  for (const h of g.data) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  for (let z = step; z < g.height - step; z += 2) for (let x = step; x < g.width - step; x += 2) {
    const i = z * g.width + x;
    const smoothed = (g.data[i - step] + g.data[i + step] + g.data[i - step * g.width] + g.data[i + step * g.width]) / 4;
    sum += (g.data[i] - smoothed) ** 2; count++;
  }
  return Math.sqrt(sum / count) / (hi - lo);
}

test.each([1, 2, 3])('default seed %i retains mid-sized landforms through erosion and hydrology', async (seed) => {
  const ctx = await initGpu();
  try {
    const p = { ...DEFAULT_PARAMS, seed };
    const base = await generateTerrain(ctx, p, 512);
    const eroded = await erode(ctx, base, p);
    const hydro = await runHydrologyInWorker(eroded, p);
    expect(mediumRelief(hydro.terrain)).toBeGreaterThan(0.015);
  } finally { ctx.device.destroy(); }
});

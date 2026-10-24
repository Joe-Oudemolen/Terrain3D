import type { Grid } from '../core/grid';
import type { HydroResult } from '../hydro/hydrology';

type Rgb = [number, number, number];
const RIVER: Rgb = [0x3d, 0x78, 0xb5];
const LAKE: Rgb = [0x2f, 0x6a, 0xa8];
const OCEAN: Rgb = [0x1f, 0x4f, 0x86];

/** Marks cells within width/2 of any river centerline point (at least the cell the point falls in). */
function rasterizeRivers(g: Grid, hydro: HydroResult): Uint8Array {
  const mask = new Uint8Array(g.width * g.height);
  const cs = g.cellSize;
  for (const r of hydro.rivers) {
    for (const q of r.points) {
      const cx = Math.round(q.x / cs);
      const cz = Math.round(q.z / cs);
      const rad = Number.isFinite(q.width) ? q.width / 2 / cs : 0;
      const reach = Math.ceil(rad);
      const r2 = rad * rad;
      for (let dz = -reach; dz <= reach; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= g.height) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= g.width) continue;
          if ((dx === 0 && dz === 0) || dx * dx + dz * dz <= r2) mask[z * g.width + x] = 1;
        }
      }
    }
  }
  return mask;
}

/** RGBA preview: grayscale by height over [min,max], with ocean, lake and river cells painted over it. */
export function colorizeTerrain(g: Grid, hydro?: HydroResult, showWater = true): Uint8Array {
  const n = g.width * g.height;
  const out = new Uint8Array(n * 4);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = g.data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const inv = hi > lo ? 255 / (hi - lo) : 0;
  const water = showWater && hydro ? hydro : undefined;
  const rivers = water ? rasterizeRivers(g, water) : undefined;
  for (let i = 0; i < n; i++) {
    let c: Rgb | undefined;
    if (water) {
      if (rivers![i]) c = RIVER;
      else if (water.lakeId[i] >= 0) c = LAKE;
      else if (water.ocean[i]) c = OCEAN;
    }
    const o = i * 4;
    if (c) {
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
    } else {
      const v = Math.round((g.data[i] - lo) * inv);
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
    }
    out[o + 3] = 255;
  }
  return out;
}

import type { Grid } from '../core/grid';
import type { HydroResult } from '../hydro/hydrology';

type Rgb = [number, number, number];
const RIVER: Rgb = [0x3d, 0x78, 0xb5];
const LAKE: Rgb = [0x2f, 0x6a, 0xa8];
const OCEAN: Rgb = [0x1f, 0x4f, 0x86];

/** Rasterize entire segments, retaining at least one pixel for narrow preview channels. */
function rasterizeRivers(g: Grid, hydro: HydroResult): Uint8Array {
  const mask = new Uint8Array(g.width * g.height);
  const cs = g.cellSize;
  for (const r of hydro.rivers) {
    for (let k = 0; k < r.points.length; k++) {
      const a = r.points[k], b = r.points[Math.min(k + 1, r.points.length - 1)];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z)) / cs * 2));
      for (let j = 0; j <= steps; j++) {
        const t = j / steps;
        const cx = Math.round((a.x + (b.x - a.x) * t) / cs);
        const cz = Math.round((a.z + (b.z - a.z) * t) / cs);
        const width = a.width + (b.width - a.width) * t;
        // A display footprint keeps subpixel-width channels legible after texture downsampling.
        // Export carving and masks use their original world-meter widths.
        const rad = Number.isFinite(width) ? Math.max(1, width / 2 / cs) : 1;
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

/** Muted grass/soil/rock preview; the separate minimap remains a grayscale heightmap. */
export function colorizeViewport(g: Grid, hydro?: HydroResult): Uint8Array {
  const out = colorizeTerrain(g, hydro);
  for (let z = 0; z < g.height; z++) for (let x = 0; x < g.width; x++) {
    const i = z * g.width + x, o = i * 4;
    if (out[o] !== out[o + 1] || out[o + 1] !== out[o + 2]) continue; // already colored water
    const elevation = out[o] / 255;
    const dx = g.data[z * g.width + Math.min(g.width - 1, x + 1)] - g.data[z * g.width + Math.max(0, x - 1)];
    const dz = g.data[Math.min(g.height - 1, z + 1) * g.width + x] - g.data[Math.max(0, z - 1) * g.width + x];
    const slope = Math.hypot(dx, dz) / (2 * g.cellSize);
    const rock = Math.min(1, Math.max(0, (slope - 0.3) / 0.6));
    const grass: Rgb = [99 + elevation * 35, 119 + elevation * 31, 77 + elevation * 35];
    const stone: Rgb = [143, 138, 122];
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(grass[c] * (1 - rock) + stone[c] * rock);
  }
  return out;
}

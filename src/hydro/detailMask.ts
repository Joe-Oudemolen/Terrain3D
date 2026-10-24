import type { Grid } from '../core/grid';
import type { River } from './riverGeometry';

const RAMP_CELLS = 3;
const RIVER_MARGIN_CELLS = 3;

function smoothstep(t: number): number {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Base-resolution mask: 1 = full detail, 0 = none. Zero within `halfWidth + 3 cells` of a river
 * centerline and on lake/ocean cells, rising to 1 with a smoothstep over 3 cells.
 */
export function buildDetailMask(g: Grid, rivers: River[], lakeId: Int32Array, ocean: Uint8Array): Grid {
  const { width: w, height: hgt, cellSize: cs } = g;
  const data = new Float32Array(w * hgt).fill(1);
  const ramp = RAMP_CELLS * cs;

  // Water cells: 0 inside; boundary cells stamp a ramp outward.
  const isWater = (i: number) => lakeId[i] >= 0 || ocean[i] !== 0;
  for (let z = 0; z < hgt; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (!isWater(i)) continue;
      data[i] = 0;
      let edge = x === 0 || z === 0 || x === w - 1 || z === hgt - 1;
      if (!edge) edge = !isWater(i - 1) || !isWater(i + 1) || !isWater(i - w) || !isWater(i + w);
      if (!edge) continue;
      for (let dz = -RAMP_CELLS; dz <= RAMP_CELLS; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= hgt) continue;
        for (let dx = -RAMP_CELLS; dx <= RAMP_CELLS; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const d = Math.hypot(dx, dz);
          if (d >= RAMP_CELLS) continue;
          const j = zz * w + xx;
          const v = smoothstep(d / RAMP_CELLS);
          if (v < data[j]) data[j] = v;
        }
      }
    }
  }

  // Rivers: distance to each segment, with the channel half width interpolated along it.
  const margin = RIVER_MARGIN_CELLS * cs;
  for (const r of rivers) {
    const pts = r.points;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[Math.min(k + 1, pts.length - 1)];
      const reach = Math.max(a.width, b.width) / 2 + margin + ramp;
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach) / cs));
      const x1 = Math.min(w - 1, Math.ceil((Math.max(a.x, b.x) + reach) / cs));
      const z0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach) / cs));
      const z1 = Math.min(hgt - 1, Math.ceil((Math.max(a.z, b.z) + reach) / cs));
      const sx = b.x - a.x;
      const sz = b.z - a.z;
      const len2 = sx * sx + sz * sz;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const px = x * cs;
          const pz = z * cs;
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - a.x) * sx + (pz - a.z) * sz) / len2)) : 0;
          const d = Math.hypot(px - (a.x + sx * t), pz - (a.z + sz * t));
          const hw = (a.width + (b.width - a.width) * t) / 2;
          const v = smoothstep((d - (hw + margin)) / ramp);
          const i = z * w + x;
          if (v < data[i]) data[i] = v;
        }
      }
    }
  }
  return { width: w, height: hgt, cellSize: cs, data };
}

import { describe, expect, test } from 'vitest';
import { clampParams } from '../../src/core/params';
import { tileLayout } from '../../src/core/tiles';
import { runHydrology } from '../../src/hydro/hydrology';
import type { River } from '../../src/hydro/riverGeometry';
import { carveTile } from '../../src/tile/carve';
import { buildRiverIndex } from '../../src/tile/riverIndex';
import { loadF32 } from '../helpers/synthetic';
import { cpuTileHeights } from '../helpers/tiles';

const L = tileLayout(2, 512);

function straightRiver(x0: number, z0: number, x1: number, z1: number, width = 6, depth = 2): River {
  const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    x: x0 + (x1 - x0) * t,
    z: z0 + (z1 - z0) * t,
    water: 9.5 - 0.5 * t,
    width,
    depth,
    flow: 1,
  }));
  return { id: 0, points: pts, source: { type: 'spring' } as never, outlet: { type: 'ocean' } as never };
}

/** Gently undulating terrain, one array per tile of the 2x2 block (row-major tiles). */
function hilly(): Float32Array[] {
  const out: Float32Array[] = [];
  for (let tz = 0; tz < 2; tz++) {
    for (let tx = 0; tx < 2; tx++) {
      const h = new Float32Array(512 * 512);
      for (let r = 0; r < 512; r++) {
        for (let c = 0; c < 512; c++) {
          const wx = (tx * 512 + c) * 2;
          const wz = (tz * 512 + r) * 2;
          h[r * 512 + c] = 10 + Math.sin(wx / 90) + Math.cos(wz / 70);
        }
      }
      out.push(h);
    }
  }
  return out;
}

describe('carveTile', () => {
  test('subpixel offsets do not introduce uphill steps in a level channel floor', () => {
    const river = straightRiver(100.3, 100.7, 900.8, 850.2, 6, 2);
    for (const p of river.points) p.water = 9;
    const h = new Float32Array(512 * 512).fill(20);
    carveTile(h, L, 0, 0, buildRiverIndex([river]));
    const values = river.points.map(p => h[Math.round(p.z / 2) * 512 + Math.round(p.x / 2)]);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1e-3);
  });
  test('bed at centerline = water - depth', () => {
    const river = straightRiver(100, 1500, 900, 1500);
    const idx = buildRiverIndex([river]);
    const h = new Float32Array(512 * 512).fill(10);
    carveTile(h, L, 0, 1, idx);
    // z=1500 m is row 750 -> local row 238; x=400 m is col 200, t = 0.375.
    const water = 9.5 - 0.5 * 0.375;
    expect(h[238 * 512 + 200]).toBeCloseTo(water - 2, 3);
    expect(h[0]).toBe(10);
  });

  test('carving never raises terrain', () => {
    const idx = buildRiverIndex([straightRiver(100, 100, 1800, 1400)]);
    const tiles = hilly();
    let lowered = 0;
    let maxRise = 0;
    for (let k = 0; k < 4; k++) {
      const before = Float32Array.from(tiles[k]);
      carveTile(tiles[k], L, k % 2, Math.floor(k / 2), idx);
      for (let i = 0; i < before.length; i++) {
        maxRise = Math.max(maxRise, tiles[k][i] - before[i]);
        if (tiles[k][i] < before[i]) lowered++;
      }
    }
    expect(lowered).toBeGreaterThan(100);
    expect(maxRise).toBe(0);
  });

  test('carving is seam-free', () => {
    const idx = buildRiverIndex([straightRiver(500, 500, 1800, 1400)]);
    const small = hilly();
    small.forEach((h, k) => carveTile(h, L, k % 2, Math.floor(k / 2), idx));
    const big = tileLayout(2, 1024);
    const bigH = new Float32Array(1024 * 1024);
    const src = hilly();
    for (let k = 0; k < 4; k++) {
      const ox = (k % 2) * 512;
      const oz = Math.floor(k / 2) * 512;
      for (let r = 0; r < 512; r++) bigH.set(src[k].subarray(r * 512, r * 512 + 512), (oz + r) * 1024 + ox);
    }
    carveTile(bigH, big, 0, 0, idx);
    let carved = 0;
    let maxDifference = 0;
    for (let k = 0; k < 4; k++) {
      const ox = (k % 2) * 512;
      const oz = Math.floor(k / 2) * 512;
      for (let r = 0; r < 512; r++) {
        for (let c = 0; c < 512; c++) {
          maxDifference = Math.max(maxDifference, Math.abs(small[k][r * 512 + c] - bigH[(oz + r) * 1024 + ox + c]));
          if (small[k][r * 512 + c] !== src[k][r * 512 + c]) carved++;
        }
      }
    }
    expect(carved).toBeGreaterThan(100);
    expect(maxDifference).toBe(0);
  });

  test('carved bed never uphill along every river (full res)', () => {
    const base = loadF32('tests/fixtures/eroded_s1_512.f32', 512, 20);
    const hydro = runHydrology(base, clampParams({ rainfall: 0.5 }));
    expect(hydro.rivers.length).toBeGreaterThanOrEqual(3);
    const idx = buildRiverIndex(hydro.rivers);
    const carved = new Map<number, Float32Array>();
    const heightAt = (px: number, pz: number) => {
      const tx = Math.floor(px / 512);
      const tz = Math.floor(pz / 512);
      const key = tz * L.tilesPerSide + tx;
      let h = carved.get(key);
      if (!h) {
        h = cpuTileHeights(hydro.terrain, L, tx, tz);
        carveTile(h, L, tx, tz, idx);
        carved.set(key, h);
      }
      return h[(pz - tz * 512) * 512 + (px - tx * 512)];
    };

    const rises: string[] = [];
    for (const river of hydro.rivers.slice(0, 3)) {
      // (1) pure carve rule: centerline profile minimum.
      let prev = Infinity;
      for (const p of river.points) {
        const bed = p.water - p.depth;
        expect(bed).toBeLessThanOrEqual(prev + 1e-4);
        prev = bed;
      }
      // (2) minimum carved height near each point, across every tile the river crosses. The pixel grid
      // rarely hits the centerline, so the lowest pixel sits up to a few mm above the profile minimum by
      // sampling offset alone (measured worst case 1.8 mm on river 2, point 25); 5 mm covers that.
      prev = Infinity;
      for (const p of river.points) {
        const rad = Math.max(L.spacing, p.width / 2);
        let min = Infinity;
        for (let pz = Math.ceil((p.z - rad) / 2); pz <= Math.floor((p.z + rad) / 2); pz++) {
          for (let px = Math.ceil((p.x - rad) / 2); px <= Math.floor((p.x + rad) / 2); px++) {
            if (Math.hypot(px * 2 - p.x, pz * 2 - p.z) > rad) continue;
            min = Math.min(min, heightAt(px, pz));
          }
        }
        if (min > prev + 5e-3) rises.push(`${river.id}:${river.points.indexOf(p)}:${(min - prev).toFixed(5)}`);
        prev = min;
      }
    }
    expect(rises).toEqual([]);
  });
});

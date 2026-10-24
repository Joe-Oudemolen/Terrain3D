import { expect, test } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { tileLayout } from '../../src/core/tiles';
import { initGpu } from '../../src/gpu/device';
import { generateTerrain } from '../../src/gpu/terrain';
import { erode } from '../../src/gpu/erosion';
import { buildTileHeights, releaseTileCache } from '../../src/gpu/detail';
import { runHydrologyInWorker } from '../../src/hydro/client';
import { carveTile, tileSegments, QUERY_MARGIN_M } from '../../src/tile/carve';
import { buildRiverIndex } from '../../src/tile/riverIndex';
import { buildChannelFloor } from '../../src/tile/channelFloor';

for (const seed of [1, 2, 3, 4, 5, 6]) for (const island of (seed === 6 ? [true] : [false, true])) {
  test(`full pipeline seed ${seed}, island ${island}: water and exported bed descend`, async () => {
    const ctx = await initGpu();
    const p = { ...DEFAULT_PARAMS, seed, island, mountainHeight: seed === 6 ? 3000 : 1200, riverWidth: seed === 6 ? 0.25 : 1, outputSpacing: seed === 6 ? 1 as const : 2 as const };
    const started = performance.now();
    try {
      const base = await generateTerrain(ctx, p, 2048);
      const eroded = await erode(ctx, base, p);
      const hydro = await runHydrologyInWorker(eroded, p);
      const generated = performance.now();
      const layout = tileLayout(p.outputSpacing, 1024);
      const idx = buildRiverIndex(hydro.rivers);
      const floor = buildChannelFloor(hydro.terrain, hydro.rivers, layout, idx);
      const tiles = new Map<number, Float32Array>();
      for (let z = 0; z < layout.tilesPerSide; z++) for (let x = 0; x < layout.tilesPerSide; x++) {
        if (!tileSegments(layout, x, z, idx, QUERY_MARGIN_M).length) continue;
        const h = await buildTileHeights(ctx, hydro.terrain, hydro.detailMask, p, layout, x, z);
        carveTile(h, layout, x, z, idx, floor);
        tiles.set(z * layout.tilesPerSide + x, h);
      }
      let maxWaterRise = 0, maxProfileRise = 0, maxRasterRise = 0;
      let worst: unknown;
      for (const river of hydro.rivers) {
        let water = Infinity, profile = Infinity, raster = Infinity;
        for (const point of river.points) {
          maxWaterRise = Math.max(maxWaterRise, point.water - water);
          maxProfileRise = Math.max(maxProfileRise, point.water - point.depth - profile);
          water = point.water; profile = point.water - point.depth;
          const px = Math.min(layout.pixels - 1, Math.max(0, Math.round(point.x / layout.spacing)));
          const pz = Math.min(layout.pixels - 1, Math.max(0, Math.round(point.z / layout.spacing)));
          const tx = Math.floor(px / 1024), tz = Math.floor(pz / 1024);
          const h = tiles.get(tz * layout.tilesPerSide + tx)!;
          const value = h[(pz % 1024) * 1024 + px % 1024];
          expect(Number.isFinite(value)).toBe(true);
          if (value - raster > maxRasterRise) worst = { river: river.id, point, value, previousRaster: raster, profile, pixel: [px, pz] };
          maxRasterRise = Math.max(maxRasterRise, value - raster); raster = value;
        }
      }
      console.log(JSON.stringify({ seed, island, generateMs: Math.round(generated - started), tileMs: Math.round(performance.now() - generated), rivers: hydro.rivers.length, maxWaterRise, maxProfileRise, maxRasterRise, worst }));
      expect(maxWaterRise).toBeLessThanOrEqual(1e-4);
      expect(maxProfileRise).toBeLessThanOrEqual(1e-4);
      expect(maxRasterRise).toBeLessThanOrEqual(1e-3);
    } finally { releaseTileCache(ctx); ctx.device.destroy(); }
  }, 240000);
}

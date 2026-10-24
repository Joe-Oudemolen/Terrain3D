import type { Grid } from '../core/grid';
import { sampleBilinear } from '../core/sample';
import type { TileLayout } from '../core/tiles';
import type { HydroResult } from '../hydro/hydrology';
import { forEachSegmentPixel, QUERY_MARGIN_M, tileSegments } from './carve';
import type { RiverIndex } from './riverIndex';

export interface WaterLookup {
  /** Lake surface height (m) at a world position, NaN if no lake. */
  lakeSurfaceAt(wx: number, wz: number): number;
  /** Ocean coverage 0..1 (bilinear). */
  oceanAt(wx: number, wz: number): number;
}

const DILATE_CELLS = 2;

/** The parts of a HydroResult the water lookup reads (the terrain only for its dimensions). */
export type WaterLookupSource = Pick<HydroResult, 'lakes' | 'lakeId' | 'ocean'> & {
  terrain: Pick<Grid, 'width' | 'height' | 'cellSize'>;
};

export function makeWaterLookup(hydro: WaterLookupSource): WaterLookup {
  const { width: w, height: hgt, cellSize: cs } = hydro.terrain;
  let ids = hydro.lakeId;
  // Dilate by DILATE_CELLS (4-neighbourhood per pass) so shore pixels see the lake's surface.
  for (let pass = 0; pass < DILATE_CELLS; pass++) {
    const next = new Int32Array(ids);
    for (let z = 0; z < hgt; z++) {
      for (let x = 0; x < w; x++) {
        const c = z * w + x;
        if (ids[c] >= 0) continue;
        if (x > 0 && ids[c - 1] >= 0) next[c] = ids[c - 1];
        else if (x < w - 1 && ids[c + 1] >= 0) next[c] = ids[c + 1];
        else if (z > 0 && ids[c - w] >= 0) next[c] = ids[c - w];
        else if (z < hgt - 1 && ids[c + w] >= 0) next[c] = ids[c + w];
      }
    }
    ids = next;
  }
  const maxId = hydro.lakes.reduce((m, k) => Math.max(m, k.id), -1);
  const surfaceById = new Float64Array(maxId + 1).fill(NaN);
  for (const k of hydro.lakes) surfaceById[k.id] = k.surface;
  const oceanGrid: Grid = { width: w, height: hgt, cellSize: cs, data: Float32Array.from(hydro.ocean) };

  return {
    lakeSurfaceAt(wx, wz) {
      const x = Math.min(w - 1, Math.max(0, Math.round(wx / cs)));
      const z = Math.min(hgt - 1, Math.max(0, Math.round(wz / cs)));
      const id = ids[z * w + x];
      return id >= 0 ? surfaceById[id] : NaN;
    },
    oceanAt: (wx, wz) => sampleBilinear(oceanGrid, wx, wz),
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** RGB water mask for a (carved) tile: R rivers, G lakes, B ocean. `tileSize^2 * 3` bytes. */
export function waterMaskTile(
  h: Float32Array,
  l: TileLayout,
  tx: number,
  tz: number,
  idx: RiverIndex,
  wl: WaterLookup,
): Uint8Array {
  const n = l.tileSize;
  const sp = l.spacing;
  const out = new Uint8Array(n * n * 3);
  const px0 = tx * n;
  const pz0 = tz * n;

  for (let r = 0; r < n; r++) {
    const wz = (pz0 + r) * sp;
    for (let c = 0; c < n; c++) {
      const wx = (px0 + c) * sp;
      const i = r * n + c;
      const surface = wl.lakeSurfaceAt(wx, wz);
      if (!Number.isNaN(surface)) out[i * 3 + 1] = Math.round(255 * clamp01((surface - h[i]) / 0.5));
      if (wl.oceanAt(wx, wz) > 0.5) out[i * 3 + 2] = Math.round(255 * clamp01(-h[i] / 0.5));
    }
  }

  // Rivers: max coverage over nearby segments; the soft edge spans one pixel spacing either side of the bank.
  for (const s of tileSegments(l, tx, tz, idx, QUERY_MARGIN_M)) {
    const reach = Math.max(s.widthA, s.widthB) / 2 + sp;
    forEachSegmentPixel(s, l, tx, tz, reach, (i, d, t) => {
      const half = (s.widthA + (s.widthB - s.widthA) * t) / 2;
      const v = Math.round(255 * clamp01((half + sp - d) / (2 * sp)));
      if (v > out[i * 3]) out[i * 3] = v;
    });
  }
  return out;
}

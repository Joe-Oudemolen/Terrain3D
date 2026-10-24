import type { TileLayout } from '../core/tiles';
import { tileOrigin } from '../core/tiles';
import type { RiverIndex, Segment } from './riverIndex';

export const BANK_SLOPE = 0.6;

/** Bevel width beyond the half-width: max(2*spacing, 0.75*width). */
export function bevelFor(width: number, spacing: number): number {
  return Math.max(2 * spacing, 0.75 * width);
}

/** Largest distance from a centerline that a segment can influence when carving. */
export function segmentReach(s: Segment, spacing: number): number {
  const w = Math.max(s.widthA, s.widthB);
  return w / 2 + bevelFor(w, spacing);
}

/**
 * Calls `fn(index, d, t)` for every tile pixel within `reach` of the segment's centerline, where d is
 * the distance to the segment and t the projection parameter in [0,1]. No per-pixel allocation.
 */
export function forEachSegmentPixel(
  s: Segment,
  l: TileLayout,
  tx: number,
  tz: number,
  reach: number,
  fn: (i: number, d: number, t: number) => void,
): void {
  const { px0, pz0 } = tileOrigin(l, tx, tz);
  const sp = l.spacing;
  const n = l.tileSize;
  const c0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - reach) / sp) - px0);
  const c1 = Math.min(n - 1, Math.ceil((Math.max(s.ax, s.bx) + reach) / sp) - px0);
  const r0 = Math.max(0, Math.floor((Math.min(s.az, s.bz) - reach) / sp) - pz0);
  const r1 = Math.min(n - 1, Math.ceil((Math.max(s.az, s.bz) + reach) / sp) - pz0);
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const len2 = dx * dx + dz * dz;
  for (let r = r0; r <= r1; r++) {
    const wz = (pz0 + r) * sp;
    for (let c = c0; c <= c1; c++) {
      const wx = (px0 + c) * sp;
      let t = len2 > 0 ? ((wx - s.ax) * dx + (wz - s.az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(wx - (s.ax + dx * t), wz - (s.az + dz * t));
      if (d <= reach) fn(r * n + c, d, t);
    }
  }
}

/** Segments that can touch the tile (query box grown by `margin` meters). */
export function tileSegments(l: TileLayout, tx: number, tz: number, idx: RiverIndex, margin: number): Segment[] {
  const { wx0, wz0 } = tileOrigin(l, tx, tz);
  const ext = l.tileSize * l.spacing;
  return idx.query(wx0 - margin, wz0 - margin, wx0 + ext + margin, wz0 + ext + margin);
}

/** Margin for tile queries: generous bound on any segment's reach (widths are a few tens of meters at most). */
export const QUERY_MARGIN_M = 128;

/**
 * Carves rivers into a full-res tile in place; only ever lowers. Depends only on world position and
 * the global river data, so neighbouring tiles agree exactly at shared pixels. The bed is the minimum
 * profile over all nearby segments.
 */
export function carveTile(h: Float32Array, l: TileLayout, tx: number, tz: number, idx: RiverIndex): void {
  const sp = l.spacing;
  for (const s of tileSegments(l, tx, tz, idx, QUERY_MARGIN_M)) {
    forEachSegmentPixel(s, l, tx, tz, segmentReach(s, sp), (i, d, t) => {
      const width = s.widthA + (s.widthB - s.widthA) * t;
      const half = width / 2;
      if (d > half + bevelFor(width, sp)) return;
      const water = s.waterA + (s.waterB - s.waterA) * t;
      let profile: number;
      if (d <= half) {
        const u = d / half;
        const depth = s.depthA + (s.depthB - s.depthA) * t;
        profile = water - depth * (1 - u * u);
      } else {
        profile = water + (d - half) * BANK_SLOPE;
      }
      if (profile < h[i]) h[i] = profile;
    });
  }
}

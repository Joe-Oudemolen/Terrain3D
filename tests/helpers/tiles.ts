import type { Grid } from '../../src/core/grid';
import { sampleBicubic } from '../../src/core/sample';
import { tileOrigin, type TileLayout } from '../../src/core/tiles';

/**
 * Full-res tile heights on the CPU: bicubic of the hydro terrain per pixel. Equals the GPU detail pass
 * wherever detailMask = 0, which holds on every river and lake.
 */
export function cpuTileHeights(terrain: Grid, l: TileLayout, tx: number, tz: number): Float32Array {
  const n = l.tileSize;
  const { wx0, wz0 } = tileOrigin(l, tx, tz);
  const h = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) h[r * n + c] = sampleBicubic(terrain, wx0 + c * l.spacing, wz0 + r * l.spacing);
  }
  return h;
}

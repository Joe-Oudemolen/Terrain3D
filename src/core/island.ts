import type { Grid } from './grid';
import type { TerrainParams } from './params';

/** With `p.island`, forces the border band (max(3 cells, 2% of width)) to at most -2 m. */
export function clampIslandEdges(g: Grid, p: TerrainParams): void {
  if (!p.island) return;
  const band = Math.ceil(Math.max(3, 0.02 * g.width));
  for (let z = 0; z < g.height; z++) {
    for (let x = 0; x < g.width; x++) {
      const d = Math.min(x, z, g.width - 1 - x, g.height - 1 - z);
      if (d < band) {
        const i = z * g.width + x;
        if (g.data[i] > -2) g.data[i] = -2;
      }
    }
  }
}

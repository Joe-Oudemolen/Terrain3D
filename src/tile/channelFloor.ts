import type { Grid } from '../core/grid';
import { sampleBicubic } from '../core/sample';
import type { TileLayout } from '../core/tiles';
import type { River } from '../hydro/riverGeometry';
import { channelProfile, QUERY_MARGIN_M } from './carve';
import type { RiverIndex } from './riverIndex';

/** Sparse global drainage constraints, independent of tile order. River detail is masked to zero. */
export function buildChannelFloor(terrain: Grid, rivers: River[], layout: TileLayout, index: RiverIndex): Map<number, number> {
  interface Node { key: number; height: number; next: Set<Node>; visited: boolean }
  const nodes = new Map<number, Node>();
  const nodeAt = (x: number, z: number): Node => {
    const px = Math.max(0, Math.min(layout.pixels - 1, Math.round(x / layout.spacing)));
    const pz = Math.max(0, Math.min(layout.pixels - 1, Math.round(z / layout.spacing)));
    const key = pz * layout.pixels + px;
    let node = nodes.get(key);
    if (node) return node;
    const wx = px * layout.spacing, wz = pz * layout.spacing;
    let height = sampleBicubic(terrain, wx, wz);
    for (const s of index.query(wx - QUERY_MARGIN_M, wz - QUERY_MARGIN_M, wx + QUERY_MARGIN_M, wz + QUERY_MARGIN_M)) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz;
      const t = len2 ? Math.max(0, Math.min(1, ((wx - s.ax) * dx + (wz - s.az) * dz) / len2)) : 0;
      const d = Math.hypot(wx - s.ax - dx * t, wz - s.az - dz * t);
      height = Math.min(height, channelProfile(s, d, t, layout.spacing));
    }
    // Cover CPU/WGSL interpolation rounding before propagating the drainage cap.
    node = { key, height: Math.fround(height - 0.002), next: new Set(), visited: false };
    nodes.set(key, node); return node;
  };
  for (const river of rivers) {
    let previous: Node | undefined;
    for (let i = 0; i < river.points.length; i++) {
      const b = river.points[i], a = river.points[Math.max(0, i - 1)];
      const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (layout.spacing / 2)));
      for (let j = i ? 1 : 0; j <= count; j++) {
        const t = j / count;
        const node = nodeAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
        if (previous && previous !== node) previous.next.add(node);
        previous = node;
      }
    }
  }
  // The lowest ancestor reaches each node first. Shared pixels connect tributaries,
  // crossings and raster cycles without depending on river IDs or tile ordering.
  const floor = new Map<number, number>();
  for (const start of [...nodes.values()].sort((a, b) => a.height - b.height || a.key - b.key)) {
    if (start.visited) continue;
    const stack = [start]; start.visited = true;
    while (stack.length) {
      const node = stack.pop()!; floor.set(node.key, start.height);
      for (const next of node.next) if (!next.visited) { next.visited = true; stack.push(next); }
    }
  }
  return floor;
}

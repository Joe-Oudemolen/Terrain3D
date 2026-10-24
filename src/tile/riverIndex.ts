import { WORLD_SIZE_M } from '../core/grid';
import type { River } from '../hydro/riverGeometry';

/** Consecutive point pair of a river (world meters), with the per-point channel values at both ends. */
export interface Segment {
  riverId: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  waterA: number;
  waterB: number;
  widthA: number;
  widthB: number;
  depthA: number;
  depthB: number;
}

export interface RiverIndex {
  /** Segments whose bounding box intersects the box (each returned once). */
  query(minX: number, minZ: number, maxX: number, maxZ: number): Segment[];
}

/** Uniform bucket grid over the world; a segment is registered in every bucket its bounding box touches. */
export function buildRiverIndex(rivers: River[], bucketM = 256): RiverIndex {
  const nb = Math.ceil(WORLD_SIZE_M / bucketM);
  const buckets: number[][] = Array.from({ length: nb * nb }, () => []);
  const segs: Segment[] = [];
  const bucketOf = (v: number) => Math.min(nb - 1, Math.max(0, Math.floor(v / bucketM)));

  for (const r of rivers) {
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const id = segs.length;
      segs.push({
        riverId: r.id,
        ax: a.x,
        az: a.z,
        bx: b.x,
        bz: b.z,
        waterA: a.water,
        waterB: b.water,
        widthA: a.width,
        widthB: b.width,
        depthA: a.depth,
        depthB: b.depth,
      });
      const x0 = bucketOf(Math.min(a.x, b.x));
      const x1 = bucketOf(Math.max(a.x, b.x));
      const z0 = bucketOf(Math.min(a.z, b.z));
      const z1 = bucketOf(Math.max(a.z, b.z));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) buckets[z * nb + x].push(id);
    }
  }

  const stamp = new Int32Array(segs.length);
  let epoch = 0;

  return {
    query(minX, minZ, maxX, maxZ) {
      epoch++;
      const out: Segment[] = [];
      const x0 = bucketOf(minX);
      const x1 = bucketOf(maxX);
      const z0 = bucketOf(minZ);
      const z1 = bucketOf(maxZ);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          for (const id of buckets[z * nb + x]) {
            if (stamp[id] === epoch) continue;
            stamp[id] = epoch;
            const s = segs[id];
            if (
              Math.max(s.ax, s.bx) < minX ||
              Math.min(s.ax, s.bx) > maxX ||
              Math.max(s.az, s.bz) < minZ ||
              Math.min(s.az, s.bz) > maxZ
            ) {
              continue;
            }
            out.push(s);
          }
        }
      }
      return out;
    },
  };
}

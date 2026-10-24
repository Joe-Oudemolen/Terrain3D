import { WORLD_SIZE_M } from './grid';

export interface TileLayout {
  spacing: 1 | 2;
  tileSize: number;
  pixels: number;
  tilesPerSide: number;
}

export function tileLayout(spacing: 1 | 2, tileSize: number): TileLayout {
  const pixels = WORLD_SIZE_M / spacing;
  if (pixels % tileSize !== 0) {
    throw new Error(`tile size ${tileSize} does not divide ${pixels} pixels`);
  }
  return { spacing, tileSize, pixels, tilesPerSide: pixels / tileSize };
}

export function tileOrigin(
  l: TileLayout,
  tx: number,
  tz: number,
): { px0: number; pz0: number; wx0: number; wz0: number } {
  const px0 = tx * l.tileSize;
  const pz0 = tz * l.tileSize;
  return { px0, pz0, wx0: px0 * l.spacing, wz0: pz0 * l.spacing };
}

export function tileFileName(kind: 'height' | 'water', tx: number, tz: number, ext: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const dir = kind === 'height' ? 'heights' : 'water';
  return `${dir}/${kind}_x${p(tx)}_z${p(tz)}.${ext}`;
}

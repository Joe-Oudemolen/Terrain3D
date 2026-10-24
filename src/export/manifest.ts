import type { Grid } from '../core/grid';
import { WORLD_SIZE_M } from '../core/grid';
import type { TerrainParams } from '../core/params';
import { tileFileName, tileOrigin, type TileLayout } from '../core/tiles';
import type { Lake } from '../hydro/lakes';
import type { River } from '../hydro/riverGeometry';

/** Terrain3D release the import script was verified against (Godot 4.7.2). */
export const TERRAIN3D_VERSION = '1.0.2';

export interface WorldJson {
  version: 1;
  worldSizeM: 10240;
  vertexSpacing: number;
  tileSize: number;
  tilesPerSide: number;
  regionSize: number;
  heightFormat: 'exr' | 'r16';
  seaLevel: 0;
  r16Range: { min: number; max: number } | null;
  origin: [0, 0, 0];
  tiles: { file: string; tx: number; tz: number; position: [number, number, number] }[];
  waterMasks: string[];
}

export function buildWorldJson(p: TerrainParams, l: TileLayout, r16: { min: number; max: number } | null): WorldJson {
  const tiles: WorldJson['tiles'] = [];
  const waterMasks: string[] = [];
  for (let tz = 0; tz < l.tilesPerSide; tz++) {
    for (let tx = 0; tx < l.tilesPerSide; tx++) {
      const { wx0, wz0 } = tileOrigin(l, tx, tz);
      tiles.push({ file: tileFileName('height', tx, tz, p.heightFormat), tx, tz, position: [wx0, 0, wz0] });
      waterMasks.push(tileFileName('water', tx, tz, 'png'));
    }
  }
  return {
    version: 1,
    worldSizeM: WORLD_SIZE_M,
    vertexSpacing: l.spacing,
    tileSize: l.tileSize,
    tilesPerSide: l.tilesPerSide,
    regionSize: l.tileSize,
    heightFormat: p.heightFormat,
    seaLevel: 0,
    r16Range: r16 ? { min: r16.min, max: r16.max } : null,
    origin: [0, 0, 0],
    tiles,
    waterMasks,
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** `terrain` is the hydro terrain grid: lake spills are stored as base-grid cell indices. */
export function buildLakesJson(lakes: Lake[], terrain: Pick<Grid, 'width' | 'cellSize'>) {
  return {
    lakes: lakes.map((k) => ({
      id: k.id,
      surface: round3(k.surface),
      bounds: k.bounds,
      areaM2: k.areaM2,
      outline: k.outline,
      spill: [(k.spill % terrain.width) * terrain.cellSize, Math.floor(k.spill / terrain.width) * terrain.cellSize] as [
        number,
        number,
      ],
    })),
  };
}

export function buildRiversJson(rivers: River[]) {
  return {
    rivers: rivers.map((r) => ({
      id: r.id,
      source: r.source,
      outlet: r.outlet,
      points: r.points.map(
        (q) => [round3(q.x), round3(q.z), round3(q.water), round3(q.width), round3(q.depth)] as [number, number, number, number, number],
      ),
    })),
  };
}

export function buildReadme(w: WorldJson, terrain3dVersion: string): string {
  const lines = [
    'Terrain3D heightmap export',
    '==========================',
    '',
    `World: ${w.worldSizeM} m x ${w.worldSizeM} m, ${w.tilesPerSide} x ${w.tilesPerSide} tiles of ${w.tileSize} x ${w.tileSize} px.`,
    `Height format: ${w.heightFormat.toUpperCase()} (${w.heightFormat === 'exr' ? '32-bit float, meters' : '16-bit unsigned, scaled'}).`,
    '',
    'Terrain3D settings',
    `  vertex_spacing = ${w.vertexSpacing}`,
    `  region_size    = ${w.regionSize}`,
    `  Target Terrain3D version: ${terrain3dVersion}`,
    '',
    'Import',
    '  1. Unzip this bundle into your Godot project (e.g. res://terrain_bundle/).',
    '  2. Add a Terrain3D node to a scene and select it. vertex_spacing and region_size are set by the script.',
    '  3. Open godot/terrain3d_import.gd in the Script editor and choose File > Run (Ctrl+Shift+X).',
    '     It reads world.json and imports every height tile at its listed position.',
    '  4. Set the Terrain3D data directory and save the scene to keep the imported regions.',
    '',
    'Coordinates',
    '  The world corner is at the origin: +x runs along image columns, +z along image rows, sea level is y = 0.',
    '  Tile positions in world.json are the world-meter origin of each tile; all world.json, lakes.json and',
    '  rivers.json coordinates are world meters. River channel beds are carved to (water - depth).',
    '',
  ];
  if (w.r16Range) {
    lines.push(
      'R16 range',
      `  min = ${w.r16Range.min} m, max = ${w.r16Range.max} m`,
      '  Import with this range: height = min + value / 65535 * (max - min).',
      '',
    );
  }
  lines.push(
    'Files',
    '  heights/*     height tiles (EXR 32-bit float meters, or R16 scaled to the range above).',
    '  world.json    world size, spacing, tile list and positions, R16 range.',
    '  water/*.png   RGB water masks: R rivers, G lakes, B ocean.',
    '  lakes.json, rivers.json   vector water data (world meters).',
    '  preset.txt    paste into the generator to reproduce this terrain.',
    '',
  );
  return lines.join('\n');
}

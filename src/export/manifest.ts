import type { Grid } from '../core/grid';
import { WORLD_SIZE_M } from '../core/grid';
import type { TerrainParams } from '../core/params';
import { tileFileName, tileOrigin, type TileLayout } from '../core/tiles';
import type { Lake } from '../hydro/lakes';
import type { River } from '../hydro/riverGeometry';

/** Set by Task 13 once the import script has been checked against a real Terrain3D release. */
export const TERRAIN3D_VERSION = 'unverified';

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
    '  1. Add a Terrain3D node, set vertex_spacing and region_size as above.',
    '  2. Run godot/terrain3d_import.gd (or use Terrain3D > Tools > Import) with world.json.',
    '  3. Each heights/ tile goes at the position listed in world.json; origin is (0, 0, 0).',
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
    'Other files',
    '  water/*.png   RGB water masks: R rivers, G lakes, B ocean.',
    '  lakes.json, rivers.json   vector water data (world meters).',
    '  preset.txt    paste into the generator to reproduce this terrain.',
    '',
  );
  return lines.join('\n');
}

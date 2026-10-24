import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { Lake } from '../hydro/lakes';
import type { River } from '../hydro/riverGeometry';
import { tileFileName, type TileLayout } from '../core/tiles';
import { carveTile } from '../tile/carve';
import { buildRiverIndex, type RiverIndex } from '../tile/riverIndex';
import { makeWaterLookup, waterMaskTile, type WaterLookup } from '../tile/waterMask';
import { encodeExrFloat } from './exr';
import { encodePngRgb } from './png';
import { encodeR16 } from './r16';

export type ExportRequest =
  | {
      type: 'init';
      layout: TileLayout;
      format: 'exr' | 'r16';
      r16: { min: number; max: number } | null;
      rivers: River[];
      lakes: Lake[];
      lakeId: Int32Array;
      ocean: Uint8Array;
      terrainDims: { width: number; height: number; cellSize: number };
    }
  | { type: 'tile'; tx: number; tz: number; heights: Float32Array }
  | { type: 'finish'; files: { name: string; text: string }[] };

export type ExportMessage =
  | { type: 'chunk'; data: Uint8Array }
  | { type: 'tile'; clamped: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ExportRequest>) => void) | null;
  postMessage(message: ExportMessage, transfer?: Transferable[]): void;
};

let layout: TileLayout;
let format: 'exr' | 'r16';
let r16: { min: number; max: number } | null;
let index: RiverIndex;
let lookup: WaterLookup;

const zip = new Zip((err, data, final) => {
  if (err) {
    ctx.postMessage({ type: 'error', message: err.message });
    return;
  }
  // Copy so the transfer detaches only our copy, not fflate's internal buffer.
  const copy = data.slice();
  ctx.postMessage({ type: 'chunk', data: copy }, [copy.buffer]);
  if (final) ctx.postMessage({ type: 'done' });
});

function addFile(name: string, data: Uint8Array, deflate: boolean): void {
  const f = deflate ? new ZipDeflate(name, { level: 1 }) : new ZipPassThrough(name);
  zip.add(f);
  f.push(data, true);
}

ctx.onmessage = (e) => {
  try {
    const m = e.data;
    if (m.type === 'init') {
      layout = m.layout;
      format = m.format;
      r16 = m.r16;
      index = buildRiverIndex(m.rivers);
      lookup = makeWaterLookup({ lakes: m.lakes, lakeId: m.lakeId, ocean: m.ocean, terrain: m.terrainDims });
    } else if (m.type === 'tile') {
      const h = m.heights;
      const n = layout.tileSize;
      carveTile(h, layout, m.tx, m.tz, index);
      const mask = waterMaskTile(h, layout, m.tx, m.tz, index, lookup);
      let clamped = 0;
      if (format === 'r16') {
        for (let i = 0; i < h.length; i++) if (!(h[i] >= r16!.min && h[i] <= r16!.max)) clamped++;
      }
      const heights = format === 'exr' ? encodeExrFloat(h, n, n) : encodeR16(h, r16!);
      addFile(tileFileName('height', m.tx, m.tz, format), heights, true);
      addFile(tileFileName('water', m.tx, m.tz, 'png'), encodePngRgb(mask, n, n), false);
      ctx.postMessage({ type: 'tile', clamped });
    } else {
      const enc = new TextEncoder();
      for (const f of m.files) addFile(f.name, enc.encode(f.text), true);
      zip.end();
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

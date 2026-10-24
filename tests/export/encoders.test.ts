import { describe, expect, test } from 'vitest';
import { PNG } from 'pngjs';
import { encodeExrFloat } from '../../src/export/exr';
import { encodeR16, r16Range } from '../../src/export/r16';
import { encodePngRgb } from '../../src/export/png';

function parseExr(bytes: Uint8Array, w: number, h: number) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const attrs: Record<string, { type: string; off: number; size: number }> = {};
  let p = 8;
  while (bytes[p] !== 0) {
    let e = p;
    while (bytes[e] !== 0) e++;
    const name = dec.decode(bytes.subarray(p, e));
    p = e + 1;
    e = p;
    while (bytes[e] !== 0) e++;
    const type = dec.decode(bytes.subarray(p, e));
    p = e + 1;
    const size = dv.getInt32(p, true);
    p += 4;
    attrs[name] = { type, off: p, size };
    p += size;
  }
  p += 1;
  const tableStart = p;
  const offsets = Array.from({ length: h }, (_, i) => Number(dv.getBigUint64(tableStart + i * 8, true)));
  return { dv, attrs, offsets, tableStart, w };
}

describe('EXR', () => {
  const w = 5, h = 3;
  const data = new Float32Array(w * h).map((_, i) => i * 1.5 - 7.25);
  const bytes = encodeExrFloat(data, w, h);

  test('magic, version, and payload floats round-trip', () => {
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x76, 0x2f, 0x31, 0x01]);
    expect(bytes[4]).toBe(2);
    expect(Array.from(bytes.subarray(5, 8))).toEqual([0, 0, 0]);
    const { dv, offsets } = parseExr(bytes, w, h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = offsets[y];
      expect(dv.getInt32(o, true)).toBe(y);
      expect(dv.getInt32(o + 4, true)).toBe(w * 4);
      for (let x = 0; x < w; x++) out[y * w + x] = dv.getFloat32(o + 8 + x * 4, true);
    }
    expect(out).toEqual(data);
    expect(offsets[h - 1] + 8 + w * 4).toBe(bytes.length);
  });

  test('header declares channel "R" FLOAT and NO_COMPRESSION', () => {
    const { dv, attrs, tableStart } = parseExr(bytes, w, h);
    expect(Object.keys(attrs).sort()).toEqual([
      'channels', 'compression', 'dataWindow', 'displayWindow', 'lineOrder',
      'pixelAspectRatio', 'screenWindowCenter', 'screenWindowWidth',
    ]);
    const ch = attrs.channels;
    expect(ch.type).toBe('chlist');
    expect(bytes[ch.off]).toBe('R'.charCodeAt(0));
    expect(bytes[ch.off + 1]).toBe(0);
    expect(dv.getInt32(ch.off + 2, true)).toBe(2);
    expect(dv.getInt32(ch.off + 10, true)).toBe(1);
    expect(dv.getInt32(ch.off + 14, true)).toBe(1);
    expect(bytes[ch.off + 18]).toBe(0);
    expect(ch.size).toBe(19);
    expect(bytes[attrs.compression.off]).toBe(0);
    expect(bytes[attrs.lineOrder.off]).toBe(0);
    const dw = attrs.dataWindow;
    expect([0, 4, 8, 12].map((d) => dv.getInt32(dw.off + d, true))).toEqual([0, 0, w - 1, h - 1]);
    expect(dv.getFloat32(attrs.screenWindowWidth.off, true)).toBe(1);
    expect(dv.getFloat32(attrs.pixelAspectRatio.off, true)).toBe(1);
    expect(tableStart + h * 8).toBe(parseExr(bytes, w, h).offsets[0]);
  });
});

describe('R16', () => {
  test('range pads by 1 m', () => {
    expect(r16Range(10, 20)).toEqual({ min: 9, max: 21 });
  });
  test('round-trip error <= (max-min)/65535', () => {
    const range = r16Range(-3, 400);
    const data = new Float32Array(1000).map((_, i) => -3 + (403 * i) / 999);
    const out = encodeR16(data, range);
    expect(out.length).toBe(2000);
    const dv = new DataView(out.buffer);
    const span = range.max - range.min;
    for (let i = 0; i < data.length; i++) {
      const back = range.min + (dv.getUint16(i * 2, true) / 65535) * span;
      expect(Math.abs(back - data[i])).toBeLessThanOrEqual(span / 65535);
    }
  });
  test('little-endian, clamped', () => {
    const out = encodeR16(new Float32Array([5, 0, 99, -99]), { min: 0, max: 5 });
    expect(Array.from(out)).toEqual([0xff, 0xff, 0, 0, 0xff, 0xff, 0, 0]);
    expect(Array.from(encodeR16(new Float32Array([1]), { min: 0, max: 65535 }))).toEqual([1, 0]);
  });
});

describe('PNG', () => {
  test('decodes with pngjs to the same RGB', () => {
    const w = 37, h = 11;
    const rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 31 + (i >> 3)) & 255);
    const png = PNG.sync.read(Buffer.from(encodePngRgb(rgb, w, h)));
    expect(png.width).toBe(w);
    expect(png.height).toBe(h);
    for (let i = 0; i < w * h; i++) {
      expect(png.data[i * 4]).toBe(rgb[i * 3]);
      expect(png.data[i * 4 + 1]).toBe(rgb[i * 3 + 1]);
      expect(png.data[i * 4 + 2]).toBe(rgb[i * 3 + 2]);
    }
  });
});

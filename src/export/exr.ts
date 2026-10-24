// Single-channel (R) 32-bit float, uncompressed scanline OpenEXR encoder. Little-endian.

const enc = new TextEncoder();

interface Attr {
  name: string;
  type: string;
  size: number;
  write: (dv: DataView, off: number) => void;
}

function box2i(name: string, x0: number, y0: number, x1: number, y1: number): Attr {
  return {
    name, type: 'box2i', size: 16,
    write: (dv, o) => {
      dv.setInt32(o, x0, true); dv.setInt32(o + 4, y0, true);
      dv.setInt32(o + 8, x1, true); dv.setInt32(o + 12, y1, true);
    },
  };
}

function float(name: string, v: number): Attr {
  return { name, type: 'float', size: 4, write: (dv, o) => dv.setFloat32(o, v, true) };
}

export function encodeExrFloat(data: Float32Array, w: number, h: number): Uint8Array {
  const attrs: Attr[] = [
    {
      name: 'channels', type: 'chlist', size: 19,
      write: (dv, o) => {
        dv.setUint8(o, 0x52); // 'R'
        dv.setUint8(o + 1, 0);
        dv.setInt32(o + 2, 2, true); // FLOAT
        dv.setUint8(o + 6, 0); // pLinear + 3 reserved bytes (o+6..o+9) stay zero
        dv.setInt32(o + 10, 1, true); // xSampling
        dv.setInt32(o + 14, 1, true); // ySampling
        dv.setUint8(o + 18, 0); // end of channel list
      },
    },
    { name: 'compression', type: 'compression', size: 1, write: (dv, o) => dv.setUint8(o, 0) },
    box2i('dataWindow', 0, 0, w - 1, h - 1),
    box2i('displayWindow', 0, 0, w - 1, h - 1),
    { name: 'lineOrder', type: 'lineOrder', size: 1, write: (dv, o) => dv.setUint8(o, 0) },
    float('pixelAspectRatio', 1),
    {
      name: 'screenWindowCenter', type: 'v2f', size: 8,
      write: (dv, o) => { dv.setFloat32(o, 0, true); dv.setFloat32(o + 4, 0, true); },
    },
    float('screenWindowWidth', 1),
  ];

  let headerSize = 8;
  for (const a of attrs) headerSize += a.name.length + 1 + a.type.length + 1 + 4 + a.size;
  headerSize += 1;
  const tableSize = h * 8;
  const rowBytes = w * 4;
  const total = headerSize + tableSize + h * (8 + rowBytes);

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0], 0);
  let p = 8;
  for (const a of attrs) {
    p += enc.encodeInto(a.name, out.subarray(p)).written + 1;
    p += enc.encodeInto(a.type, out.subarray(p)).written + 1;
    dv.setInt32(p, a.size, true);
    p += 4;
    a.write(dv, p);
    p += a.size;
  }
  p += 1; // header terminator (already zero)

  let blockOff = p + tableSize;
  for (let y = 0; y < h; y++) {
    dv.setBigUint64(p + y * 8, BigInt(blockOff), true);
    dv.setInt32(blockOff, y, true);
    dv.setInt32(blockOff + 4, rowBytes, true);
    let o = blockOff + 8;
    const base = y * w;
    for (let x = 0; x < w; x++, o += 4) dv.setFloat32(o, data[base + x], true);
    blockOff += 8 + rowBytes;
  }
  return out;
}

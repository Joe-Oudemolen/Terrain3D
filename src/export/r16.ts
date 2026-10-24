/** Height range for R16 export, padded by 1 m on each side. */
export function r16Range(min: number, max: number): { min: number; max: number } {
  return { min: min - 1, max: max + 1 };
}

/** Little-endian uint16: round((h - min) / (max - min) * 65535), clamped. */
export function encodeR16(data: Float32Array, range: { min: number; max: number }): Uint8Array {
  const out = new Uint8Array(data.length * 2);
  const dv = new DataView(out.buffer);
  const scale = 65535 / (range.max - range.min);
  for (let i = 0; i < data.length; i++) {
    let v = Math.round((data[i] - range.min) * scale);
    if (!(v > 0)) v = 0;
    else if (v > 65535) v = 65535;
    dv.setUint16(i * 2, v, true);
  }
  return out;
}

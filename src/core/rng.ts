/** Deterministic randomness. All generation randomness derives from params.seed through here. */

export function hash32(...ints: number[]): number {
  let h = 0x811c9dc5;
  for (const v of ints) {
    h ^= v >>> 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function deriveSeed(seed: number, label: string): number {
  const codes: number[] = [seed >>> 0, label.length];
  for (let i = 0; i < label.length; i++) codes.push(label.charCodeAt(i));
  return hash32(...codes);
}

import type { Grid } from '../core/grid';

/** 1 where h < 0 and 4-connected through h < 0 cells to the map border. Iterative flood fill. */
export function labelOcean(g: Grid): Uint8Array {
  const { width: w, height: hgt, data } = g;
  const ocean = new Uint8Array(w * hgt);
  const stack = new Int32Array(w * hgt);
  let sp = 0;
  const seed = (i: number) => {
    if (data[i] < 0 && !ocean[i]) {
      ocean[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((hgt - 1) * w + x);
  }
  for (let z = 0; z < hgt; z++) {
    seed(z * w);
    seed(z * w + w - 1);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const z = (i - x) / w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (z > 0) seed(i - w);
    if (z < hgt - 1) seed(i + w);
  }
  return ocean;
}

/** Border cells plus ocean cells: where water leaves the map. */
export function outletMask(g: Grid, ocean: Uint8Array): Uint8Array {
  const { width: w, height: hgt } = g;
  const out = new Uint8Array(w * hgt);
  out.set(ocean);
  for (let x = 0; x < w; x++) {
    out[x] = 1;
    out[(hgt - 1) * w + x] = 1;
  }
  for (let z = 0; z < hgt; z++) {
    out[z * w] = 1;
    out[z * w + w - 1] = 1;
  }
  return out;
}

/** Binary min-heap over (Float64 key, Int32 id). Ties on key break toward the smaller id, so pops are deterministic. */
export class MinHeap {
  private keys: Float64Array;
  private ids: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.ids = new Int32Array(capacity);
  }

  /** Key of the minimum element (undefined behaviour when empty). */
  get topKey(): number {
    return this.keys[0];
  }

  private less(ka: number, ia: number, kb: number, ib: number): boolean {
    return ka < kb || (ka === kb && ia < ib);
  }

  push(key: number, id: number): void {
    if (this.size === this.keys.length) this.grow();
    const keys = this.keys;
    const ids = this.ids;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(key, id, keys[p], ids[p])) break;
      keys[i] = keys[p];
      ids[i] = ids[p];
      i = p;
    }
    keys[i] = key;
    ids[i] = id;
  }

  /** Removes the minimum and returns its id. */
  pop(): number {
    const keys = this.keys;
    const ids = this.ids;
    const top = ids[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n];
      const id = ids[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.less(keys[c + 1], ids[c + 1], keys[c], ids[c])) c++;
        if (!this.less(keys[c], ids[c], key, id)) break;
        keys[i] = keys[c];
        ids[i] = ids[c];
        i = c;
      }
      keys[i] = key;
      ids[i] = id;
    }
    return top;
  }

  private grow(): void {
    const cap = this.keys.length * 2;
    const k = new Float64Array(cap);
    const d = new Int32Array(cap);
    k.set(this.keys);
    d.set(this.ids);
    this.keys = k;
    this.ids = d;
  }
}

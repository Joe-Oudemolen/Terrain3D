export const WORLD_SIZE_M = 10240;

/** Row-major scalar field: data[z * width + x]. */
export interface Grid {
  width: number;
  height: number;
  cellSize: number;
  data: Float32Array;
}

export function makeGrid(size: number, cellSize: number): Grid {
  return { width: size, height: size, cellSize, data: new Float32Array(size * size) };
}

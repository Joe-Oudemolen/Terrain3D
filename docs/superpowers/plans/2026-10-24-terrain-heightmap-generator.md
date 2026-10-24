# Terrain Heightmap Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser app that generates eroded mountain terrain with rivers, lakes and optional ocean. It exports seamless Terrain3D height tiles, RGB water masks, lake/river JSON, and a one-click Godot import script.

**Architecture:**
- **Base pass, on the GPU (WebGPU compute):** noise shaping, then pipe-model hydraulic erosion plus thermal erosion, at 2048² or 4096².
- **Hydrology, on the CPU in a Web Worker:** priority-flood, lakes, ocean, D8 flow and river polylines.
- **Export, tile by tile:**
  - On the GPU: bicubic upsample plus masked detail noise.
  - In an export worker: river carving, water masks, file encoding and zip streaming.
  - The zip streams to disk.
- **UI:** a Three.js viewport, a canvas minimap and a Tweakpane panel, driven by a latest-wins pipeline controller.

**Tech Stack:** TypeScript, Vite, WebGPU/WGSL, Three.js, Tweakpane, fflate, Vitest (Node project + browser project via Playwright/Chrome), pngjs (test-only).

**Spec:** `docs/superpowers/specs/2026-10-24-terrain-heightmap-generator-design.md`

## Global Constraints

- World is fixed at **10240 m × 10240 m** (`WORLD_SIZE_M = 10240`).
- Output spacing: **1 m/px (10240²)** or **2 m/px (5120²)**.
- Base quality **2048** (default) or **4096**. It is a *generation* setting, and Export reuses the generated base.
- Heights are **absolute meters, sea level = y 0**. Ocean surface is always 0.
- Heights are exported as **EXR 32-bit float or R16 only, never PNG**.
- Water mask: **one RGB PNG per tile, R = rivers, G = lakes, B = ocean, soft 0–255 edges**.
- **No GPU buffer may exceed 128 MiB** (the default `maxStorageBufferBindingSize`). Use one buffer per scalar channel. The full-resolution map is never held in one GPU buffer.
- **WebGPU required.** If it's missing, show a clear message. There is no CPU fallback.
- **Determinism:**
  - No `Math.random` anywhere in generation code. All randomness derives from `params.seed` via `src/core/rng.ts`.
  - No atomics in erosion shaders.
  - Heap and sort tie-breaks use cell index.
- **Rivers never uphill:** along every river, exported `water` and carved bed height are non-increasing from source to mouth. Tolerance is `1e-4` m.
- **Lake outlets:** a lake's outlet river starts at exactly the lake's surface height. A tributary's last point has `water >=` the main river's water at the junction.
- **World coordinates (plan decision, satisfies the spec's "verify convention"):**
  - Map corner at world origin, **+x = image column, +z = image row**.
  - Pixel `(col,row)` of the full-res map sits at world `(col*spacing, row*spacing)`.
  - Base cell `(i,j)` sits at `(i*cellSize, j*cellSize)`, where `cellSize = 10240 / baseSize`.
  - Tiles import at `Vector3(tx*tileSize*spacing, 0, tz*tileSize*spacing)`.
- Tile size ∈ {512, 1024, 2048}, default 1024, and must divide the output pixel count. 2048 is invalid at 2 m.
- All dependencies are free/open source.
- Reference machine: RTX 3050 Laptop GPU (4 GB VRAM). Targets:
  - Preview under 1 s.
  - Generate at 2048 in tens of seconds.
  - Export at 1 m in a few minutes with a responsive page.

## Review Focus

1. **Rapid slider dragging or clicking Generate while something runs:** the newest request wins. An older result must never overwrite a newer one. *(Task 14: `latest request wins`.)*
2. **GPU device lost mid-Generate/Export** (laptop sleep, driver reset): the UI shows an error and a retry works. No hang. *(Task 14: `device lost → error state, recoverable`.)*
3. **User dismisses the save dialog or cancels an export:** no error is shown and no partial file is left behind. *(Task 12: `dismissed picker returns null`, `abort aborts sink`.)*
4. **Corrupt or old preset pasted, or localStorage throwing** (private mode, quota): fall back to defaults with a message. Never crash. *(Task 1: `decodePreset rejects garbage`, `loadSavedParams survives throwing storage`.)*
5. **Degenerate settings** (rainfall 0, sea level at max, flatland 1, island on with a tiny map): hydrology and export still produce valid files with empty `rivers`/`lakes` arrays. *(Task 8: `degenerate settings`.)*

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, vitest.config.ts, index.html, .gitignore
src/
  main.ts                    app bootstrap/wiring
  core/
    params.ts                TerrainParams, defaults, ranges, clamp, presets, localStorage
    rng.ts                   seeded hashing / PRNG
    grid.ts                  Grid type + helpers, WORLD_SIZE_M
    sample.ts                CPU Catmull-Rom bicubic + bilinear (must match WGSL)
    tiles.ts                 tile layout + naming + world coords
    island.ts                clampIslandEdges
  gpu/
    device.ts                initGpu, errors, lost handling
    buffers.ts               storage buffer + readback helpers
    wgsl/common.wgsl         hash/noise/bicubic shared code
    wgsl/terrain.wgsl, erosion.wgsl, thermal.wgsl, detail.wgsl
    terrain.ts               generateTerrain
    erosion.ts               erode
    detail.ts                buildTileHeights
  hydro/
    heap.ts                  MinHeap (deterministic)
    priorityFlood.ts         fillDepressions, fillEpsilon
    ocean.ts                 labelOcean
    lakes.ts                 findLakes, lakeOutlines
    flow.ts                  flowReceivers, flowAccumulation
    network.ts               extractNetwork
    riverGeometry.ts         buildRivers
    detailMask.ts            buildDetailMask
    hydrology.ts             runHydrology
    hydro.worker.ts, client.ts
  tile/
    riverIndex.ts            spatial index of river segments
    carve.ts                 carveTile
    waterMask.ts             waterMaskTile
  export/
    exr.ts, r16.ts, png.ts   encoders
    manifest.ts              world/lakes/rivers JSON, README, preset text
    sink.ts                  openSaveSink (File System Access, Blob fallback)
    export.worker.ts         carve + mask + encode + zip
    exporter.ts              exportBundle orchestration
  app/
    pipeline.ts              latest-wins controller/state machine
  ui/
    colorize.ts              terrain + water RGBA for viewport/minimap
    viewport.ts              Three.js view
    minimap.ts               canvas minimap, camera marker, swap
    panel.ts                 Tweakpane panel
    status.ts                progress/error overlay
godot/terrain3d_import.gd    shipped in zip (imported ?raw)
tests/
  helpers/synthetic.ts       synthetic heightmaps, assertNeverUphill
  fixtures/eroded_s{1,2,3}_512.f32   captured from real GPU runs (Task 4)
  **/*.test.ts               Node project
  **/*.gpu.test.ts           Browser project (real GPU, local only)
```

---

### Task 1: Project scaffold, params, presets, RNG

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `.gitignore`, `src/main.ts` (placeholder), `src/core/params.ts`, `src/core/rng.ts`, `src/core/grid.ts`
- Test: `tests/core/params.test.ts`, `tests/core/rng.test.ts`

**Interfaces:**
- Produces:
  - `WORLD_SIZE_M = 10240`
  - `interface Grid { width: number; height: number; cellSize: number; data: Float32Array }` (row-major `data[z*width+x]`)
  - `makeGrid(size: number, cellSize: number): Grid`
  - `TerrainParams` (fields below), `DEFAULT_PARAMS`, `PARAM_RANGES`
  - `clampParams(p: Partial<TerrainParams>): TerrainParams`
  - `encodePreset(p: TerrainParams): string`
  - `decodePreset(s: string): TerrainParams` (throws `PresetError`)
  - `loadSavedParams(storage?: Storage | null): { params: TerrainParams; warning?: string }`
  - `saveParams(p: TerrainParams, storage?: Storage | null): void`
  - `hash32(...ints: number[]): number`
  - `mulberry32(seed: number): () => number`
  - `deriveSeed(seed: number, label: string): number`

`TerrainParams` fields, with defaults and ranges:

| Field | Default | Range |
|---|---|---|
| `seed` | 1 | uint32 |
| `mountainHeight` | 1200 | 100–3000 m |
| `ruggedness` | 0.5 | 0–1 |
| `ridgeSharpness` | 0.6 | 0–1 |
| `featureScale` | 3 | 0.5–10 km |
| `flatland` | 0.3 | 0–1 |
| `erosionStrength` | 0.5 | 0–1 |
| `erosionDuration` | 0.5 | 0–1 |
| `sedimentDeposition` | 0.5 | 0–1 |
| `thermalSmoothing` | 0.4 | 0–1 |
| `rainfall` | 0.5 | 0–1 |
| `riverWidth` | 1 | 0.25–3 |
| `lakeFill` | 0.5 | 0–1 |
| `minLakeSize` | 5000 | 500–200000 m² |
| `seaLevel` | 0.05 | 0–0.5, fraction of mountainHeight |
| `island` | false | |
| `coastlineWidth` | 1 | 0.2–3 km |
| `baseQuality` | 2048 | 2048 \| 4096 |
| `outputSpacing` | 1 | 1 \| 2 |
| `tileSize` | 1024 | 512 \| 1024 \| 2048 |
| `heightFormat` | `'exr'` | `'exr'` \| `'r16'` |

- [ ] **Step 1: Scaffold.**
  - `git init`, then `npm init -y`.
  - Install runtime deps: `npm i three tweakpane fflate`.
  - Install dev deps: `npm i -D typescript vite vitest @vitest/browser-playwright playwright @webgpu/types @types/three pngjs @types/pngjs`.
  - `.gitignore`: `node_modules/ dist/ .superpowers/ test-results/`.
  - `tsconfig.json`: `strict`, `"types": ["@webgpu/types", "vite/client"]`.
  - `vitest.config.ts`: two `projects`.
    - `node`: includes `tests/**/*.test.ts`, excludes `*.gpu.test.ts`.
    - `gpu`: includes `tests/**/*.gpu.test.ts`, with `browser.enabled: true`, `provider: playwright({ launchOptions: { channel: 'chrome', args: ['--enable-unsafe-webgpu'] } })`, `headless: false`, `instances: [{ browser: 'chromium' }]`.
  - Scripts: `"dev": "vite"`, `"build": "tsc --noEmit && vite build"`, `"test": "vitest run --project node"`, `"test:gpu": "vitest run --project gpu"`.
  - Commit the spec too.

- [ ] **Step 2: Write failing tests**

```ts
// tests/core/params.test.ts
test('preset round-trips', () => {
  const p = { ...DEFAULT_PARAMS, seed: 48213, island: true };
  expect(decodePreset(encodePreset(p))).toEqual(p);
});
test('clampParams clamps ranges and fixes tileSize 2048 at 2 m', () => {
  const p = clampParams({ mountainHeight: 99999, outputSpacing: 2, tileSize: 2048 });
  expect(p.mountainHeight).toBe(3000);
  expect(p.tileSize).toBe(1024);
});
test('decodePreset rejects garbage', () => {
  for (const s of ['', 'abc', btoa('{"v":99}'), btoa('not json')])
    expect(() => decodePreset(s)).toThrow(PresetError);
});
test('decodePreset fills missing fields from defaults', () => {
  /* encode {v:1, seed:7} → decoded.seed 7, other fields = DEFAULT_PARAMS */
});
test('loadSavedParams survives throwing storage', () => {
  const bad = { getItem() { throw new Error('denied'); } } as unknown as Storage;
  const r = loadSavedParams(bad);
  expect(r.params).toEqual(DEFAULT_PARAMS);
  expect(r.warning).toBeDefined();
});
test('loadSavedParams with corrupt stored value → defaults + warning', () => { /* getItem returns '%%%' */ });

// tests/core/rng.test.ts
test('mulberry32 is deterministic', () => { /* two generators with seed 5 → same 100 values */ });
test('deriveSeed differs by label', () => {
  expect(deriveSeed(1, 'a')).not.toBe(deriveSeed(1, 'b'));
});
```

- [ ] **Step 3: Run `npm test`.** Expected: FAIL (modules missing).
- [ ] **Step 4: Implement `params.ts`, `rng.ts` and `grid.ts`.**
  - Preset format: base64url of JSON `{ v: 1, ...params }`.
  - Storage key: `terrain-gen:params`.
  - Every storage access is wrapped in try/catch.
- [ ] **Step 5: Run `npm test`.** Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat: scaffold, params, presets, rng"`

---

### Task 2: Sampling and tile layout (CPU)

**Files:**
- Create: `src/core/sample.ts`, `src/core/tiles.ts`
- Test: `tests/core/sample.test.ts`, `tests/core/tiles.test.ts`

**Interfaces:**
- Produces:
  - `sampleBicubic(g: Grid, wx: number, wz: number): number`
    - Catmull-Rom (a = −0.5), coordinates in world meters, `u = wx / g.cellSize`, clamp-to-edge.
  - `sampleBilinear(g: Grid, wx: number, wz: number): number`
  - `interface TileLayout { spacing: 1|2; tileSize: number; pixels: number; tilesPerSide: number }`
  - `tileLayout(spacing: 1|2, tileSize: number): TileLayout` (throws if `pixels % tileSize !== 0`)
  - `tileOrigin(l: TileLayout, tx: number, tz: number): { px0: number; pz0: number; wx0: number; wz0: number }`
  - `tileFileName(kind: 'height'|'water', tx: number, tz: number, ext: string): string` → `heights/height_x03_z07.exr`, `water/water_x03_z07.png`

- [ ] **Step 1: Write failing tests**

```ts
test('bicubic reproduces grid values at nodes', () => { /* random 8x8 grid, cellSize 5: sampleBicubic(g, 5*i, 5*j) ≈ g.data[j*8+i] (1e-5) */ });
test('bicubic reproduces linear ramps exactly', () => { /* h = 2x+3z → sample at (7.3, 11.9) ≈ 2*7.3+3*11.9 */ });
test('clamps outside the grid', () => { /* sample(-10,-10) == data[0] */ });
test('tileLayout 1m/1024 → 10x10', () => {
  expect(tileLayout(1, 1024)).toEqual({ spacing: 1, tileSize: 1024, pixels: 10240, tilesPerSide: 10 });
});
test('tileLayout 2m/2048 throws', () => {
  expect(() => tileLayout(2, 2048)).toThrow();
});
test('tileOrigin', () => {
  expect(tileOrigin(tileLayout(2, 512), 3, 1)).toEqual({ px0: 1536, pz0: 512, wx0: 3072, wz0: 1024 });
});
test('tileFileName zero-pads', () => {
  expect(tileFileName('height', 3, 7, 'exr')).toBe('heights/height_x03_z07.exr');
});
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: bicubic sampling and tile layout`

---

### Task 3: WebGPU device + terrain shaping

**Files:**
- Create: `src/gpu/device.ts`, `src/gpu/buffers.ts`, `src/gpu/wgsl/common.wgsl`, `src/gpu/wgsl/terrain.wgsl`, `src/gpu/terrain.ts`, `src/core/island.ts`
- Test: `tests/gpu/terrain.gpu.test.ts`, `tests/core/island.test.ts`

**Interfaces:**
- Consumes: `Grid`, `makeGrid`, `TerrainParams`, `deriveSeed`.
- Produces:
  - `interface GpuContext { device: GPUDevice; lost: Promise<GPUDeviceLostInfo> }`
  - `initGpu(): Promise<GpuContext>` (throws `WebGpuUnavailableError`; requests default limits only)
  - `createStorage(ctx, src: Float32Array | number): GPUBuffer`
  - `readback(ctx, buf: GPUBuffer, length: number): Promise<Float32Array>`
  - `generateTerrain(ctx: GpuContext, p: TerrainParams, size: number): Promise<Grid>`
    - Returns meters, already shifted so sea level = 0: `h = (n - p.seaLevel) * p.mountainHeight`, where `n ∈ [0,1]`.
  - `clampIslandEdges(g: Grid, p: TerrainParams): void`
    - When `p.island`, every cell within `max(3 cells, 2% of width)` of the border becomes `min(h, -2)`. No-op otherwise.
- Noise recipe and slider mapping are the builder's choice (spec §10), with these requirements:
  - Integer-hash gradient noise in `common.wgsl` (PCG hash).
  - Seed offsets from `deriveSeed(seed, 'terrain')`, passed as a uniform.
  - Sampled in **world meters**, so preview (512) and base (2048/4096) show the same shape.
  - Island falloff: `n *= smoothstep(0, coastlineWidth*1000, distToEdge)`, then pushed below `seaLevel` at the edge.
  - `common.wgsl` also holds `bicubic()`, matching `sampleBicubic` exactly (same Catmull-Rom weights and clamping).

- [ ] **Step 1: Write failing tests**

```ts
// tests/gpu/terrain.gpu.test.ts
const ctx = await initGpu();
test('same seed → identical heights', async () => {
  const a = await generateTerrain(ctx, DEFAULT_PARAMS, 256);
  const b = await generateTerrain(ctx, DEFAULT_PARAMS, 256);
  expect(a.data).toEqual(b.data);
});
test('different seed → different heights', async () => { /* seed 1 vs 2, some element differs */ });
test('cellSize and finite range', async () => {
  const g = await generateTerrain(ctx, DEFAULT_PARAMS, 256);
  expect(g.cellSize).toBe(40);
  for (const v of g.data) {
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(DEFAULT_PARAMS.mountainHeight);
  }
});
test('island: all border cells < 0', async () => {
  /* params island:true → every cell in row 0, row 255, col 0, col 255 < 0 */
});
test('preview and base agree in shape', async () => {
  /* sizes 128 and 512: bilinear-sampled correlation of the two > 0.95 */
});

// tests/core/island.test.ts
test('clampIslandEdges lowers the border band only when island', () => { /* ... */ });
```

- [ ] **Step 2: Run `npm run test:gpu` and `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - WGSL is imported via `?raw`.
  - Workgroup size 8×8.
  - `initGpu` attaches `device.lost` and throws `WebGpuUnavailableError` when `navigator.gpu` or the adapter is missing.
- [ ] **Step 4: Run both test commands.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: WebGPU terrain shaping with island falloff`

---

### Task 4: GPU erosion (hydraulic pipe model + thermal) and fixture capture

**Files:**
- Create: `src/gpu/wgsl/erosion.wgsl`, `src/gpu/wgsl/thermal.wgsl`, `src/gpu/erosion.ts`
- Test: `tests/gpu/erosion.gpu.test.ts`
- Produces fixtures: `tests/fixtures/eroded_s{1,2,3}_512.f32`

**Interfaces:**
- Consumes: `GpuContext`, `createStorage`, `readback`, `generateTerrain`, `clampIslandEdges`.
- Produces: `erode(ctx: GpuContext, g: Grid, p: TerrainParams, opts?: { signal?: AbortSignal; onProgress?: (f: number) => void }): Promise<Grid>`
  - Returns a new Grid. `clampIslandEdges` is applied at the end.
  - Rejects with `DOMException('AbortError')` when aborted.

**Algorithm** (the slider mapping is the builder's choice). Each simulation step dispatches, in order:
1. **Rain:** `w += rainRate*dt`.
2. **Outflow flux** to 4 neighbors: `f = max(0, f + dt*A*g*Δ(h+w)/l)`, scaled by `K = min(1, w*l²/(Σf*dt))`. Out-of-bounds neighbors count as `terrain = own terrain, water = 0`, so water drains off the map.
3. **Water and velocity update** from the in/out flux.
4. **Erosion/deposition:** capacity `C = Kc*sin(tilt)*|v|*clamp(w/depthRef,0,1)`. If `C > s`, erode `Ks*(C−s)`. Otherwise deposit `Kd*(s−C)`. `Kd` comes from `sedimentDeposition`.
5. **Semi-Lagrangian sediment advection:** bilinear gather at `x − v*dt`.
6. **Evaporation:** `w *= 1 − Ke*dt`.

Thermal erosion runs every `N` steps as a two-pass **gather**:
- Pass 1: each cell computes its outflow to lower neighbors above the talus angle.
- Pass 2: each cell sums its neighbors' outflow toward it and subtracts its own.

Constraints:
- One buffer per scalar channel: `terrain, water, sediment, fluxL/R/T/B, velX, velZ`, ping-pong where needed. Each buffer at 4096² is 64 MiB.
- No atomics.
- Steps run in chunks of 50. After each chunk: `await device.queue.onSubmittedWorkDone()`, report progress, check `signal`.
- Total steps = `round(lerp(300, 3000, erosionDuration) * baseSize/2048)`.

- [ ] **Step 1: Write failing tests**

```ts
test('erode is deterministic', async () => { /* same input twice → equal data */ });
test('erode changes terrain, produces no NaN', async () => {
  /* mean |after-before| > 0.1 m; all finite */
});
test('volume roughly conserved', async () => {
  /* |Σafter − Σbefore| / Σ|before| < 0.05 (sediment may leave via edges) */
});
test('progress is monotonic and ends at 1', async () => { /* collect onProgress values */ });
test('abort rejects with AbortError within one chunk', async () => {
  /* controller.abort() after first progress → rejects name 'AbortError' */
});
test('island border still < 0 after erosion', async () => { /* ... */ });
test.runIf(import.meta.env.VITE_CAPTURE_FIXTURES === '1')('capture fixtures', async () => {
  // seeds 1,2,3 at 512: generateTerrain + erode; write raw Float32 LE via commands.writeFile(path, base64, 'base64')
});
```

- [ ] **Step 2: Run `npm run test:gpu`.** Expected: FAIL.
- [ ] **Step 3: Implement `erode`.**
- [ ] **Step 4: Run `npm run test:gpu`.** Expected: PASS.
  - Then run `VITE_CAPTURE_FIXTURES=1 npm run test:gpu` and confirm three ~1 MiB `.f32` files exist in `tests/fixtures/`.
  - Open one rendered as an image (quick script or the dev page) and confirm visible valleys.
- [ ] **Step 5: Commit** the fixtures as well. `feat: GPU hydraulic + thermal erosion`

---

### Task 5: Priority-flood, ocean, lakes (CPU)

**Files:**
- Create: `src/hydro/heap.ts`, `src/hydro/priorityFlood.ts`, `src/hydro/ocean.ts`, `src/hydro/lakes.ts`, `tests/helpers/synthetic.ts`
- Test: `tests/hydro/priorityFlood.test.ts`, `tests/hydro/ocean.test.ts`, `tests/hydro/lakes.test.ts`

**Interfaces:**
- Produces:
  - `class MinHeap`: Float64 keys + Int32 ids; ties are broken by smaller id.
  - `labelOcean(g: Grid): Uint8Array`
    - 1 where `h < 0` and 4-connected through `h < 0` cells to the map border.
  - `outletMask(g: Grid, ocean: Uint8Array): Uint8Array`
    - Border cells + ocean cells.
  - `fillDepressions(g: Grid, outlets: Uint8Array): Float32Array`
    - Plain priority-flood (Barnes 2014). Flat fills allowed.
  - `fillEpsilon(surface: Float32Array, g: Grid, outlets: Uint8Array, eps = 1e-3): Float32Array`
    - Every non-outlet cell gets a strictly lower 8-neighbor.
  - `interface Lake { id: number; surface: number; cellCount: number; spill: number; bounds: { minX: number; minZ: number; maxX: number; maxZ: number }; areaM2: number; outline: [number, number][] }`
    - `spill` is a cell index.
    - Bounds and outline are in world meters.
  - `findLakes(g: Grid, filled: Float32Array, ocean: Uint8Array, p: TerrainParams): { lakeId: Int32Array; lakes: Lake[] }`
    - Depression = connected (8-conn) cells with `filled − h > 1e-3`.
    - The component becomes a lake iff `areaM2 >= p.minLakeSize` and `maxDepth >= lerp(5, 0.25, p.lakeFill)`. Otherwise it gets `lakeId = -1`.
    - `surface` = the component's filled level.
    - `spill` = the lowest rim cell through which the component drains (recorded during the flood).
    - `outline` = the largest marching-squares ring of the component, simplified with Douglas-Peucker (tolerance = `cellSize`).
  - `tests/helpers/synthetic.ts`:
    - `bowlGrid(size, cellSize, rimHeight, depth)`
    - `pitGrid(...)`
    - `valueNoiseGrid(seed, size, cellSize, amp)`
    - `loadF32(path, size, cellSize): Grid` (reads a fixture via `fs`)

- [ ] **Step 1: Write failing tests**

```ts
test('fillDepressions: bowl fills to rim height', () => { /* filled value inside bowl == rim spill height */ });
test('fillEpsilon: every non-outlet cell has a strictly lower 8-neighbour', () => {
  /* run on valueNoiseGrid seeds 1..20 */
});
test('fillEpsilon never lowers terrain', () => { /* out[i] >= h[i] */ });
test('labelOcean: inland below-zero basin is not ocean', () => {
  /* ring of land h=10 enclosing h=-5 interior, border h=-5 → interior 0, border 1 */
});
test('findLakes: big deep bowl → one lake with surface = rim spill', () => { /* ... */ });
test('findLakes: tiny pit is not a lake (minLakeSize)', () => { /* ... */ });
test('findLakes: lakeFill 0 rejects a 1 m deep basin, lakeFill 1 accepts it', () => { /* ... */ });
test('lake bounds/outline in world meters', () => { /* bowl centred at (500,500) m → bounds contain it */ });
test('deterministic', () => { /* same input → deep-equal output */ });
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** `fillEpsilon` follows Barnes' Priority-Flood+ε, with a plain FIFO for cells raised to the spill level.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: priority-flood, ocean and lake detection`

---

### Task 6: Flow routing and river network topology

**Files:**
- Create: `src/hydro/flow.ts`, `src/hydro/network.ts`
- Test: `tests/hydro/flow.test.ts`, `tests/hydro/network.test.ts`

**Interfaces:**
- Consumes: `fillEpsilon`, `Lake`, `lakeId`, `ocean`, `outletMask`.
- Produces:
  - `flowReceivers(surface: Float32Array, g: Grid, outlets: Uint8Array): Int32Array`
    - D8 steepest descent on the ε-filled surface.
    - `-1` for outlets.
    - Lake cells point along the flood path toward their lake's spill.
  - `flowAccumulation(receivers: Int32Array, surface: Float32Array, cellArea: number): Float32Array`
    - Contributing area in m².
    - Processed in descending-surface order (ties broken by index).
  - `riverThreshold(p: TerrainParams): number`
    - Contributing area in m²: `lerp(4e6, 0.15e6, p.rainfall)`.
    - At `rainfall = 0` it returns `Infinity` (no rivers).
  - `type Endpoint = { type: 'spring' } | { type: 'lake'; id: number } | { type: 'ocean' } | { type: 'edge' } | { type: 'river'; id: number; pointIndex: number }`
  - `interface RiverPath { id: number; cells: number[]; flow: number[]; source: Endpoint; outlet: Endpoint }`
  - `extractNetwork(g: Grid, receivers: Int32Array, acc: Float32Array, lakeId: Int32Array, lakes: Lake[], ocean: Uint8Array, threshold: number): RiverPath[]`

**Network rules:**
- A channel cell has `acc >= threshold` and is not a lake or ocean cell.
- At a confluence, the inflow with the largest `acc` continues the river. Each other inflow becomes its own `RiverPath`, ending at the junction cell with `outlet = { type: 'river', id, pointIndex }`.
- A lake whose spill cell has `acc >= threshold` gets an outlet path starting at the spill cell, with `source = { type: 'lake', id }`.
- Rivers entering a lake stop at the first lake cell, with `outlet = { type: 'lake' }`.
- Rivers end at an ocean cell (`ocean`) or a border cell (`edge`).
- Ids are assigned in order of decreasing mouth flow, ties broken by mouth cell index.

- [ ] **Step 1: Write failing tests**

```ts
test('accumulation on a tilted plane grows downslope', () => { /* ... */ });
test('every receiver is strictly lower on the eps surface', () => { /* valueNoise seeds 1..20 */ });
test('no rivers when rainfall = 0', () => { /* riverThreshold → Infinity → [] */ });
test('V-shaped valley → one river along the valley floor', () => {
  /* synthetic V valley sloping in z: single path, all cells in the centre column */
});
test('Y-shaped valleys → main + one tributary joined at junction', () => {
  /* tributary.outlet.type === 'river' and its last cell === main.cells[pointIndex] */
});
test('lake with enough inflow gets an outlet river starting at its spill', () => { /* ... */ });
test('river into lake stops at first lake cell', () => { /* ... */ });
test('every cell appears in at most one path except junction cells', () => { /* ... */ });
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: flow routing and river network`

---

### Task 7: River geometry — smoothing, meanders, widths, water heights

**Files:**
- Create: `src/hydro/riverGeometry.ts`
- Test: `tests/hydro/riverGeometry.test.ts`

**Interfaces:**
- Consumes: `RiverPath`, `Lake`, `sampleBicubic`, `deriveSeed`.
- Produces:
  - `interface RiverPoint { x: number; z: number; water: number; width: number; depth: number; flow: number }`
    - World meters; `flow` is contributing area in m².
  - `interface River { id: number; points: RiverPoint[]; source: Endpoint; outlet: Endpoint }`
  - `buildRivers(paths: RiverPath[], terrain: Grid, lakes: Lake[], p: TerrainParams): River[]`
    - `terrain` = hydro terrain with pits filled.
  - Added to `tests/helpers/synthetic.ts`:
    - `assertNeverUphill(rivers: River[], tol = 1e-4)`
    - `pipelineOnSynthetic(seed: number, p?: Partial<TerrainParams>): River[]`, which runs `valueNoiseGrid` → ocean → flood → lakes → flow → network → `buildRivers`.

**Algorithm.** Signatures and tests don't fully determine it, so it's spelled out:
1. **Centerline:** cell centers → 3 iterations of Chaikin smoothing. Endpoints are pinned. A tributary's last point is pinned to the main river's junction point.
2. **Meander:**
   - Resample at a spacing of `cellSize`.
   - Offset each point laterally by `A * sin(2π s / λ + φ)`, where:
     - `λ = 12 * width`
     - `φ` comes from `deriveSeed(seed, 'meander'+id)`
     - `A = width * 1.2 * (1 − clamp(slope / 0.05, 0, 1))`
   - Reject an offset (fall back to 0 for that point) if `sampleBicubic(terrain, offsetPoint) > sampleBicubic(terrain, originalPoint) + 0.5`. This keeps meanders out of valley walls.
   - Endpoints and junction points get zero offset.
3. **Width and depth from flow** (`riverWidth` scales width only):
   - `width = clamp(p.riverWidth * 0.004 * sqrt(flow), 2, 60)` m.
   - `depth = clamp(0.25 * sqrt(width), 0.3, 2.5)` m.
   - Afterwards, force width and depth to be non-decreasing along the river with a running max.
4. **Water height:**
   - `raw[i] = sampleBicubic(terrain, x_i, z_i) − freeboard`, where `freeboard = 0.15 + 0.05*width`.
   - Then `water[i] = min(raw[i], water[i−1])`, i.e. a running min.
   - Then clamp from below by the outlet level: lake surface for a lake outlet, 0 for ocean, the main river's `water` at `pointIndex` for a tributary. Use `max` with that level. Max with a constant keeps the sequence non-increasing.
   - A lake-outlet river has `water[0] = lake.surface`.
   - Process rivers in id order (mains first), so the main river's water exists before its tributaries'.

- [ ] **Step 1: Write failing tests**

```ts
test('never uphill on synthetic terrains', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rivers = pipelineOnSynthetic(seed); // helper: flood → lakes → flow → network → buildRivers
    assertNeverUphill(rivers); // water[i+1] <= water[i] + 1e-4
  }
});
test('width and depth non-decreasing downstream', () => { /* ... */ });
test('tributary end water >= main water at junction', () => { /* ... */ });
test('lake outlet starts at lake surface', () => { /* points[0].water === lake.surface */ });
test('river into ocean ends with water >= 0', () => { /* ... */ });
test('meander amplitude ~0 on steep slopes, > 0 on flats', () => {
  /* steep synthetic: max lateral deviation < 0.1*width; flat: > 0.3*width */
});
test('smoothed polyline has no 45°/90° stair-steps', () => {
  /* max turn angle between consecutive segments < 35° */
});
test('deterministic', () => { /* ... */ });
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: river geometry with monotonic water heights`

---

### Task 8: Hydrology orchestrator + worker

**Files:**
- Create: `src/hydro/detailMask.ts`, `src/hydro/hydrology.ts`, `src/hydro/hydro.worker.ts`, `src/hydro/client.ts`
- Test: `tests/hydro/hydrology.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–7.
- Produces:
  - `interface HydroResult { terrain: Grid; lakes: Lake[]; rivers: River[]; ocean: Uint8Array; lakeId: Int32Array; detailMask: Grid }`
    - `terrain`: the base after pit-filling. Non-lake cells take the ε-filled value; lake cells keep the original bed.
    - `detailMask`: base-res, 1 = full detail, 0 = none. It is 0 within `halfWidth + 3*cellSize` of a river and inside lakes/ocean, with a smoothstep ramp over 3 cells.
  - `runHydrology(base: Grid, p: TerrainParams, onProgress?: (f: number) => void): HydroResult`
  - `runHydrologyInWorker(base: Grid, p: TerrainParams, signal?: AbortSignal, onProgress?): Promise<HydroResult>`
    - Typed arrays are transferred.
    - Abort terminates the worker and rejects with `AbortError`.

- [ ] **Step 1: Write failing tests**

```ts
const fixtures = [1, 2, 3].map(s => loadF32(`tests/fixtures/eroded_s${s}_512.f32`, 512, 20));
test('never uphill on real eroded fixtures × settings', () => {
  for (const f of fixtures)
    for (const rainfall of [0.2, 0.5, 0.9])
      for (const island of [false, true]) {
        const r = runHydrology(f, clampParams({ rainfall, island }));
        assertNeverUphill(r.rivers);
      }
});
test('fixtures produce at least one river at default rainfall', () => { /* ... */ });
test('degenerate settings', () => {
  // rainfall 0 → rivers []; seaLevel 0.5 with mountainHeight 100 → mostly ocean, no throw;
  // flatland 1 + flat grid of zeros → lakes [] rivers [], every array finite
});
test('terrain >= original except lake beds equal original', () => { /* ... */ });
test('detailMask is 0 on river centerlines and lake cells', () => { /* ... */ });
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** the orchestrator, worker and client. Progress weights: flood 30%, lakes 10%, flow 30%, rivers 30%.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: hydrology pipeline in a worker`

---

### Task 9: GPU detail pass for full-res tiles

**Files:**
- Create: `src/gpu/wgsl/detail.wgsl`, `src/gpu/detail.ts`
- Test: `tests/gpu/detail.gpu.test.ts`

**Interfaces:**
- Consumes: `GpuContext`, `HydroResult.terrain`, `HydroResult.detailMask`, `TileLayout`, `tileOrigin`, the `bicubic()` in `common.wgsl`.
- Produces: `buildTileHeights(ctx: GpuContext, terrain: Grid, detailMask: Grid, p: TerrainParams, l: TileLayout, tx: number, tz: number): Promise<Float32Array>`
  - Returns `tileSize²` meters.
  - Per pixel: `h = bicubic(terrain, w) + detailMaskBilinear(w) * detail(w)`, where `w` is the pixel's world position.
  - `detail` is fBm in **world coordinates** (this is what makes tiles seamless), seeded by `deriveSeed(seed,'detail')`, with amplitude `lerp(0.5, 4, ruggedness)` m and wavelengths 4–64 m.
  - Base `terrain` and `detailMask` are uploaded once per export and cached on a `WeakMap<Grid, GPUBuffer>`.

- [ ] **Step 1: Write failing tests**

```ts
test('matches CPU bicubic where detailMask = 0', async () => {
  /* mask all zero → every pixel within 1e-3 of sampleBicubic(terrain, wx, wz) */
});
test('seamless: adjacent tiles continue smoothly', async () => {
  /* layout(2,512): last column of tile(0,0) vs first column of tile(1,0):
     |a−b| <= max |gradient| * spacing + 1e-3, and equal to computing a 2-tile wide strip */
});
test('deterministic', async () => { /* ... */ });
```

- [ ] **Step 2: Run `npm run test:gpu`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm run test:gpu`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: full-res tile detail pass`

---

### Task 10: River carving and water masks (CPU, per tile)

**Files:**
- Create: `src/tile/riverIndex.ts`, `src/tile/carve.ts`, `src/tile/waterMask.ts`
- Test: `tests/tile/carve.test.ts`, `tests/tile/waterMask.test.ts`

**Interfaces:**
- Consumes: `River`, `Lake`, `HydroResult.lakeId`, `HydroResult.ocean`, `TileLayout`, `tileOrigin`, `sampleBilinear`.
- Produces:
  - `buildRiverIndex(rivers: River[], bucketM = 256): RiverIndex`
  - `RiverIndex.query(minX, minZ, maxX, maxZ): Segment[]`, where `Segment` = consecutive point pair + river id.
  - `carveTile(h: Float32Array, l: TileLayout, tx: number, tz: number, idx: RiverIndex): void`
    - In place, and **only ever lowers** terrain.
    - For each pixel, find the nearest segment point (projected, with water/width/depth interpolated) and `d` = distance to the centerline.
    - `half = width/2`, `bevel = max(2*spacing, 0.75*width)`.
    - `d <= half`: `profile = water − depth*(1 − (d/half)²)`.
    - `half < d <= half + bevel`: `profile = water + (d − half) * bankSlope`, where `bankSlope = 0.6`.
    - `h = min(h, profile)`.
  - `interface WaterLookup { lakeSurfaceAt(wx: number, wz: number): number /* NaN if none */; oceanAt(wx: number, wz: number): number /* 0..1 bilinear */ }`
  - `makeWaterLookup(hydro: HydroResult): WaterLookup`
    - Lake surface uses the nearest base cell, then dilates by 2 cells using the neighboring lake id, so shorelines are covered.
  - `waterMaskTile(h: Float32Array, l: TileLayout, tx: number, tz: number, idx: RiverIndex, wl: WaterLookup): Uint8Array`
    - RGB, `tileSize²*3` bytes.
    - **R** = `255 * clamp((half + spacing − d) / (2*spacing), 0, 1)`
    - **G** = `255 * clamp((surface − h) / 0.5, 0, 1)` where a lake exists.
    - **B** = `255 * clamp(−h / 0.5, 0, 1) * (oceanAt > 0.5 ? 1 : 0)`

- [ ] **Step 1: Write failing tests**

```ts
test('bed at centerline = water − depth', () => {
  /* straight synthetic river on flat 10 m terrain: carved h at centre pixels ≈ water−depth (1e-3) */
});
test('carved bed never uphill along every river (full res)', () => {
  /* hydro on fixture s1 → carve the tiles crossing river 0 at layout(2,512) → sample bed along points → non-increasing (1e-3) */
});
test('carving never raises terrain', () => { /* ... */ });
test('carving is seam-free', () => { /* carving tiles (0,0),(1,0) separately == carving one 2-tile-wide buffer */ });
test('mask: river centre R=255, far away R=0, soft edge has intermediate values', () => { /* ... */ });
test('mask: inland below-zero lake is G not B; ocean is B', () => { /* ... */ });
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: full-res river carving and water masks`

---

### Task 11: File encoders (EXR, R16, PNG)

**Files:**
- Create: `src/export/exr.ts`, `src/export/r16.ts`, `src/export/png.ts`
- Test: `tests/export/encoders.test.ts`

**Interfaces:**
- Produces:
  - `encodeExrFloat(data: Float32Array, w: number, h: number): Uint8Array`
    - Scanline, `NO_COMPRESSION`, single channel **`R`**, `FLOAT` (pixel type 2), `INCREASING_Y`.
    - Attributes: `channels, compression, dataWindow, displayWindow, lineOrder, pixelAspectRatio, screenWindowCenter, screenWindowWidth`.
    - Line offset table, then one block per scanline: `int32 y, int32 size, data`.
  - `r16Range(min: number, max: number): { min: number; max: number }`
    - Pads by 1 m on each side.
  - `encodeR16(data: Float32Array, range: { min: number; max: number }): Uint8Array`
    - Little-endian uint16, `round((h − min)/(max − min) * 65535)`, clamped.
  - `encodePngRgb(rgb: Uint8Array, w: number, h: number): Uint8Array`
    - 8-bit RGB, filter type 1 (Sub) per row, `zlibSync` from fflate at level 6, CRC32 per chunk.

- [ ] **Step 1: Write failing tests**

```ts
test('EXR: magic, version, and payload floats round-trip', () => {
  /* bytes 0..3 = 76 2f 31 01; version byte 2; parse offset table → first scanline y=0 and floats equal input */
});
test('EXR: header declares channel "R" FLOAT and NO_COMPRESSION', () => { /* parse attributes */ });
test('R16: round-trip error <= (max−min)/65535', () => { /* ... */ });
test('R16: little-endian', () => { /* value max → bytes ff ff, min → 00 00 */ });
test('PNG decodes with pngjs to the same RGB', () => { /* PNG.sync.read */ });
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: EXR, R16 and PNG encoders`

---

### Task 12: Export bundle — manifests, worker, zip streaming, save sink

**Files:**
- Create: `src/export/manifest.ts`, `src/export/sink.ts`, `src/export/export.worker.ts`, `src/export/exporter.ts`
- Test: `tests/export/manifest.test.ts`, `tests/export/sink.test.ts`, `tests/export/exporter.gpu.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 7, 8, 9, 10, 11; `encodePreset`; `godot/terrain3d_import.gd?raw` (created in Task 13; until then use an empty placeholder file).
- Produces:
  - `buildWorldJson(p: TerrainParams, l: TileLayout, r16: { min: number; max: number } | null): WorldJson`
    - `WorldJson = { version: 1; worldSizeM: 10240; vertexSpacing; tileSize; tilesPerSide; regionSize: tileSize; heightFormat; seaLevel: 0; r16Range: {min,max}|null; origin: [0,0,0]; tiles: { file; tx; tz; position: [x,0,z] }[]; waterMasks: string[] }`
  - `buildLakesJson(lakes: Lake[])` → `{ lakes: { id, surface, bounds, areaM2, outline, spill: [x,z] }[] }`
  - `buildRiversJson(rivers: River[])` → `{ rivers: { id, source, outlet, points: [x,z,water,width,depth][] }[] }`
  - `buildReadme(w: WorldJson, terrain3dVersion: string): string`
  - `interface ByteSink { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }`
  - `openSaveSink(suggestedName: string, w?: Window): Promise<ByteSink | null>`
    - Uses `showSaveFilePicker` when present and returns `null` on `AbortError`.
    - Otherwise falls back to a Blob plus an `<a download>` link on `close`.
  - `exportBundle(ctx: GpuContext, hydro: HydroResult, p: TerrainParams, sink: ByteSink, opts: { signal?: AbortSignal; onProgress?: (f: number) => void }): Promise<void>`

**Export flow:**
- **R16 range (plan decision):** computed up front as `[min(terrain) − maxRiverDepth − detailAmp, max(terrain) + detailAmp]`, a conservative bound. No second pass is needed.
- Main thread, per tile in row-major order: `buildTileHeights`, then post the Float32Array (transferred) to the worker.
- The worker:
  - holds the rivers, the index and the water lookup (sent once);
  - runs `carveTile` + `waterMaskTile` + the encoders;
  - adds the files to an fflate `Zip` (`ZipPassThrough` for PNG, `ZipDeflate` level 1 for heights);
  - posts zip chunks back.
- The main thread awaits `sink.write` for each chunk.
- Backpressure: at most 2 tiles are in flight.
- Then the worker adds `world.json`, `lakes.json`, `rivers.json`, `preset.txt`, `README.txt` and `godot/terrain3d_import.gd`, and finalizes the zip.
- On abort: terminate the worker, `sink.abort()`, reject with `AbortError`.

- [ ] **Step 1: Write failing tests**

```ts
// manifest.test.ts
test('world.json for 1 m/1024', () => {
  const w = buildWorldJson(DEFAULT_PARAMS, tileLayout(1, 1024), null);
  expect(w.tiles).toHaveLength(100);
  expect(w.tiles[13]).toEqual({ file: 'heights/height_x03_z01.exr', tx: 3, tz: 1, position: [3072, 0, 1024] });
});
test('world.json for 2 m/512 R16 includes range', () => { /* tiles 100, positions step 1024 m, r16Range set */ });
test('rivers.json points are [x,z,water,width,depth]', () => { /* ... */ });
test('README mentions vertex spacing, region size, r16 range, Terrain3D version', () => { /* ... */ });

// sink.test.ts
test('dismissed picker returns null', async () => {
  const w = { showSaveFilePicker: () => Promise.reject(new DOMException('x', 'AbortError')) };
  expect(await openSaveSink('a.zip', w as any)).toBeNull();
});

// exporter.gpu.test.ts (small: fixture s1 as base, layout(2,512) but limited via a test-only `tiles` filter of 2x2)
test('zip contains expected files and unzips cleanly', async () => {
  /* memory sink → fflate.unzipSync → heights/*.exr x4, water/*.png x4, world.json, lakes.json, rivers.json, preset.txt, README.txt, godot/terrain3d_import.gd */
});
test('abort aborts sink and rejects', async () => { /* sink.abort called, no close */ });
```

`exportBundle` takes an optional test-only `opts.tiles?: [number, number][]` to restrict which tiles are exported.

- [ ] **Step 2: Run `npm test` and `npm run test:gpu`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: streaming export bundle`

---

### Task 13: Godot import script + README content

**Files:**
- Create: `godot/terrain3d_import.gd`
- Modify: `src/export/manifest.ts` (the `buildReadme` text and the `TERRAIN3D_VERSION` constant)

**Interfaces:**
- Consumes: the `world.json` schema from Task 12.
- Produces: an EditorScript that the user runs from the Script editor (File → Run) with a Terrain3D node selected.

**Script behavior:**
1. `@tool extends EditorScript`. Locate the bundle folder as `get_script().resource_path.get_base_dir().get_base_dir()`, so the user copies the unzipped folder into their project.
2. Read `world.json`. The selected node must be a `Terrain3D`; otherwise `push_error` and return.
3. Set the terrain's vertex spacing to `vertexSpacing` and its region size to `regionSize`.
4. For each tile:
   - Load the image with `Terrain3DUtil.load_image(path, ResourceLoader.CACHE_MODE_IGNORE, Vector2(r16Range.min, r16Range.max), Vector2i(tileSize, tileSize))`.
   - Call `terrain.data.import_images([img, null, null], Vector3(position), 0.0, 1.0)`.
   - Print `Imported i/N`.
5. Print a done message telling the user to save the scene/data directory.

- [ ] **Step 1: Install the current stable Terrain3D 1.x** into a scratch Godot 4 project and record the exact version in `TERRAIN3D_VERSION`.
- [ ] **Step 2: Check the API names against that version.** Confirm `vertex_spacing`, the region size setter (`change_region_size` vs property), `Terrain3DUtil.load_image` and `Terrain3DData.import_images`, plus whether `import_images` expects world or pixel positions when `vertex_spacing != 1`, in that version's class reference. Adjust the script; if positions are pixel-based, divide by spacing.
- [ ] **Step 3: Write the script and the README text.** The README covers:
  - the install steps;
  - what each file is;
  - the coordinate convention (corner at origin, +x columns, +z rows, sea at y = 0);
  - the R16 range;
  - the tested Terrain3D version.
- [ ] **Step 4: Manual verification.**
  - Export a 2 m/1024 bundle from the dev build, then unzip it into the scratch project and run the script.
  - Expected:
    - 25 regions;
    - no seams visible at region borders;
    - a node placed at a `lakes.json` lake `spill` x/z with y = `surface` sits on the shoreline;
    - a node at a `rivers.json` point sits on the water line.
  - Repeat with EXR at 1 m (100 tiles) and with R16.
- [ ] **Step 5: Commit.** `feat: Terrain3D import script and README`

---

### Task 14: Pipeline controller (latest-wins, progress, cancel, errors) + colorize

**Files:**
- Create: `src/app/pipeline.ts`, `src/ui/colorize.ts`
- Test: `tests/app/pipeline.test.ts`, `tests/ui/colorize.test.ts`

**Interfaces:**
- Consumes: `generateTerrain`, `erode`, `runHydrologyInWorker`, `exportBundle`, `openSaveSink`, `initGpu` (all via an injected deps object, so tests use fakes).
- Produces:
  - `type PipelineState = { kind: 'idle' } | { kind: 'busy'; task: 'preview'|'generate'|'export'; progress: number } | { kind: 'error'; message: string; retry: () => void }`
  - `class Pipeline`
    - `constructor(deps: PipelineDeps)`
    - `preview(p): void` (debounced 120 ms; base size 512, no erosion/hydro)
    - `generate(p): Promise<void>` (terrain 5%, erosion 70%, hydro 25%)
    - `export(): Promise<void>` (uses the params of the last successful generate)
    - `cancel(): void`
    - `onState(cb)`, `onResult(cb: (r: { kind: 'preview'|'generate'; base: Grid; hydro?: HydroResult; params: TerrainParams }) => void)`
  - Rules:
    - Starting `preview` or `generate` aborts any in-flight preview or generate.
    - A stale run's result is dropped (generation counter).
    - `export` is refused while a generate is busy and needs a completed generate first.
    - On `ctx.lost`: state `error` with message `"GPU was reset. Click retry."`; `retry` re-runs `initGpu` and the last request.
  - `colorizeTerrain(g: Grid, hydro?: HydroResult, showWater = true): Uint8Array`
    - RGBA. Grayscale by height normalized to [min,max].
    - Water blended in: river `#3d78b5`, lake `#2f6aa8`, ocean `#1f4f86`.

- [ ] **Step 1: Write failing tests**

```ts
test('latest request wins', async () => {
  /* fake generate resolves after 50 ms; call generate(A) then generate(B) at 10 ms → onResult called once with B; A's signal aborted */
});
test('preview is debounced', async () => { /* 5 calls in 50 ms → 1 fake run */ });
test('export without generate is refused', async () => { /* ... */ });
test('export with dismissed picker returns to idle, no error', async () => { /* openSaveSink → null */ });
test('device lost → error state, recoverable', async () => {
  /* resolve fake lost promise mid-generate → state error; retry() → re-init called, generate re-run, state idle */
});
test('erosion AbortError is not surfaced as an error', async () => { /* ... */ });
test('colorize: ocean cell gets ocean color', () => { /* ... */ });
```

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: pipeline controller`

---

### Task 15: Viewport and minimap

**Files:**
- Create: `src/ui/viewport.ts`, `src/ui/minimap.ts`
- Test: `tests/ui/minimap.test.ts` (pure geometry helpers only)

**Interfaces:**
- Consumes: `Grid`, `colorizeTerrain`.
- Produces:
  - `createViewport(container: HTMLElement): Viewport`, where `Viewport = { setTerrain(g: Grid, rgba: Uint8Array): void; getCameraPose(): { x: number; z: number; yaw: number }; setContainer(el: HTMLElement): void; dispose(): void }`
    - Three.js `WebGLRenderer`.
    - Mesh: `PlaneGeometry` at `min(g.width, 1024)` segments, with heights downsampled from `g`.
    - Material: `MeshStandardMaterial` with a color `DataTexture`.
    - `OrbitControls`, sun `DirectionalLight` + `HemisphereLight`, sky background.
    - World units = meters (so camera pose maps straight to world x/z).
    - Uses a `ResizeObserver`.
  - `createMinimap(container: HTMLElement, onSwap: () => void): Minimap`, where `Minimap = { setImage(rgba: Uint8Array, w: number, h: number): void; setCamera(pose): void; setWaterVisible(b: boolean): void; setContainer(el: HTMLElement): void }`
    - Canvas; resizable by a CSS `resize: both` wrapper (min 160 px, max 50% of the viewport); click → `onSwap`.
    - A small 💧 toggle button in the minimap's corner calls `setWaterVisible`. Clicking it must not trigger a swap.
  - `worldToMinimap(x: number, z: number, canvasPx: number): [number, number]` (pure; tested)
- Swapping: `main.ts` swaps which element (full-window or inset) each one renders into via `setContainer`.

- [ ] **Step 1: Write failing test** `worldToMinimap(5120, 5120, 200)` → `[100, 100]`, and `(0, 10240, 200)` → `[0, 200]`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement both.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
  - Then run `npm run dev` with a temporary `main.ts` that renders a fixture.
  - Expected: a lit, orbitable terrain; the minimap shows the map with the marker moving as you orbit; clicking swaps the views.
- [ ] **Step 5: Commit.** `feat: 3D viewport and minimap`

---

### Task 16: Panel, app wiring, status/errors

**Files:**
- Create: `src/ui/panel.ts`, `src/ui/status.ts`
- Modify: `src/main.ts`, `index.html`

**Interfaces:**
- Consumes: `Pipeline`, `Viewport`, `Minimap`, params/presets, `initGpu`.
- Produces: the running app.
  - `createPanel(container, params, handlers: { onChange(p, key): void; onGenerate(): void; onCancel(): void; onExport(): void; onRandomSeed(): void; onCopyPreset(): void; onPastePreset(s: string): void })`
    - Floating top-right; collapsible folders named **Seed, Terrain, Erosion, Water, Island, Quality, Export**, with exactly the controls in spec §6.4.
    - The coastline slider is disabled unless Island is on.
    - Tile size 2048 is disabled at 2 m.

**Behavior:**
- Changes to Terrain/Island/sea level, or to the seed, call `pipeline.preview`. Erosion/Water/Quality changes mark the result as "stale — press Generate".
- Every change is `saveParams`'d.
- On load:
  - `loadSavedParams`, showing `warning` as a dismissible notice;
  - `initGpu()`; on `WebGpuUnavailableError`, render a full-page message ("This app needs WebGPU — use current Chrome or Edge") and stop;
  - then auto-run `preview`.
- `status.ts` shows a progress bar with a Cancel button while busy, and an error banner with a Retry button.
- Pasting a bad preset shows "That preset couldn't be read" and leaves the params unchanged.

- [ ] **Step 1: Implement the panel, status and wiring.**
- [ ] **Step 2: Run `npm run build`.** Expected: no type errors; `dist/` produced.
- [ ] **Step 3: Manual check with `npm run dev`.**
  - Dragging a Terrain slider updates the preview within about 1 s.
  - Generate shows progress, Cancel stops it, and the result has eroded valleys, blue rivers and lakes on the minimap.
  - Island on gives ocean all around.
  - Copy preset → randomize seed → paste preset restores the same map.
  - Reload restores the settings.
  - Export downloads a zip.
- [ ] **Step 4: Commit.** `feat: control panel and app wiring`

---

### Task 17: End-to-end GPU test, performance check, final verification

**Files:**
- Create: `tests/e2e/pipeline.gpu.test.ts`
- Modify: `README.md` (the project README: how to run, test and use)

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write the e2e test.**
  - Seeds 1–5 × `island` {false, true}, at base 2048.
  - Run `generateTerrain` → `erode` → `runHydrology`, then `buildTileHeights` + `carveTile` for every tile that a river touches at layout(2, 1024).
  - Assert `assertNeverUphill(rivers)` and carved-bed monotonicity (sample the carved tile at each river point; non-increasing within 1e-3).
  - Log the timings.
- [ ] **Step 2: Run `npm run test:gpu`.** Expected: PASS.
- [ ] **Step 3: Measure performance on the RTX 3050 laptop** using the dev build and `performance.now()` logs.
  - Expected:
    - preview < 1 s;
    - Generate 2048 in tens of seconds;
    - Generate 4096 completes without a device-lost error;
    - Export at 1 m EXR in a few minutes, with the page staying interactive (orbiting still works).
  - Record the numbers in `README.md`.
  - If a target is missed, tune the erosion step count or chunk size before continuing.
- [ ] **Step 4: Run `npm test`, `npm run test:gpu` and `npm run build`.** Expected: all green.
- [ ] **Step 5: Commit.** `test: end-to-end never-uphill check and perf notes`

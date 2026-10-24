# Terrain Heightmap Generator — Design

Date: 2026-10-24
Status: Approved 2026-10-24

## 1. Intent

A browser app that generates semi-realistic game terrain for **Godot with the Terrain3D plugin**: mountains with eroded valleys, rivers, ponds and lakes, and optionally an island surrounded by ocean. The user picks a seed, adjusts sliders, generates, previews in 3D, and exports a bundle that imports straight into Terrain3D. The bundle also carries the data needed to place water in Godot.

The bar is **believable in-game**, not geologically accurate. The thing the user most wants to avoid is **rivers that look fake or run uphill**.

The target machine is a **laptop GPU**, so performance and memory use are first-class concerns.

## 2. Goals

- Generate a ~10×10 km world at **1 m/px (10240²)**, with **2 m/px (5120²)** as an option.
- Realistic mountains with hydraulic and thermal erosion: carved valleys, sediment-filled valley floors, scree slopes.
- Rivers that form natural branching networks, always flow downhill, and widen downstream.
- Lakes and ponds where the terrain naturally holds water.
- An optional island mode with ocean on all sides.
- Sliders + seed, with a **Generate** button. Results are reproducible from the seed and slider values.
- Export:
  - heightmap tiles for Terrain3D
  - a water mask that separates rivers, lakes, and ocean
  - lake data (surface heights and bounds)
  - river centerline data
- Runs entirely in the browser: no server, nothing to install.

## 3. Non-goals (v1)

- Drawing or painting controls (placing ridges, routing rivers by hand). This is a likely **later** feature, so the architecture shouldn't block it, but it isn't built now.
- A Godot-side script that auto-builds lake planes and river meshes from the JSON. Possibly later. (The **terrain import** script *is* in scope; see §6.7.)
- Texture splatmaps, vegetation maps, or biome maps beyond the water mask.
- A CPU fallback for browsers without WebGPU.
- Accounts, a cloud gallery, or any backend.
- Geological or physical accuracy beyond "looks right".

## 4. Anti-goals (failure even if it "works")

- **Any river segment that runs uphill**, in the carved riverbed or in the exported water heights.
- Rivers that look painted on: running across slopes instead of along valley floors, keeping a constant width from source to mouth, or forming a hard-edged rectangular trench.
- Hillsides covered in a hairy mess of tiny streams.
- An app that freezes the browser or runs out of GPU memory on a typical laptop.
- Visible seams between exported tiles.
- Exported data (lakes, rivers, masks) that doesn't line up with the terrain in Godot without manual fiddling.

## 5. Constraints

- **Target hardware:** the reference machine is the user's laptop with an **NVIDIA RTX 3050 Laptop GPU (4 GB VRAM)**. Defaults must run comfortably there. 4096 base quality and 1 m/px export must also work there, possibly slower. Weaker integrated GPUs should still work at default settings, just more slowly.
- **Browser:** WebGPU is required (current Chrome and Edge on Windows). If WebGPU is missing, show a clear message.
- **Cost:** all tools and libraries must be free and open source.
- **Godot import:** Godot reduces 16-bit PNGs to 8 bits on import, so **heights must not be exported as PNG**. Use EXR (32-bit float) or R16 raw.
- **WebGPU buffer limits:** a full 10240² float buffer is ~400 MB, which is over the default 128 MB storage-buffer binding limit on many laptops. The full-resolution pass therefore has to work **tile by tile** and never hold the full-resolution map in one GPU buffer.

## 6. Decisions made in conversation

### 6.1 Tech stack (proposed by Claude, accepted by the user)

| Piece | Choice |
|---|---|
| Language / build | TypeScript + Vite (no UI framework; Angular was considered and rejected as overkill) |
| Heavy compute | WebGPU compute shaders (WGSL) |
| 3D preview | Three.js |
| Slider panel | Tweakpane |
| Zip export | fflate, run in a Web Worker |
| Tests | Vitest |
| Hosting | Static files (local, GitHub Pages, or similar) |

### 6.2 Two-stage pipeline (proposed by Claude, accepted by the user)

Full-resolution erosion isn't practical on a laptop GPU, so the pipeline works the way Gaea and World Machine do:

1. **Base pass**, at **2048²** by default or **4096²** in "high quality". For a 10 km map that's about 5 m/px or 2.5 m/px.
   - Noise-based terrain shaping, with island falloff when enabled.
   - GPU hydraulic erosion. Proposed approach: a grid-based shallow-water "virtual pipe" model, where water flows between neighboring cells and moves sediment. It parallelizes well on a GPU.
   - GPU thermal erosion (talus/scree).
   - Hydrology: depression handling, lake detection, flow accumulation, river extraction (see §7).
   - This pass decides the shape of the land: ridges, valleys, drainage, river paths, lake basins.
2. **Detail / export pass**, at the final resolution (1 m or 2 m/px), **tile by tile**.
   - Upscale the base heightmap smoothly (bicubic or similar; no visible blockiness).
   - Add fine detail noise, masked so it doesn't roughen riverbeds or lake surfaces.
   - Carve rivers at full resolution from the river polylines, with beveled banks.
   - Flatten lake beds and surfaces as needed, so lake data matches the terrain.
   - Write the water mask at full resolution.

### 6.3 Layout (user chose this from mockups)

- The **3D view fills the window.**
- A **collapsible slider panel floats in the top-right** corner.
- A **resizable minimap sits in the bottom-left**. It shows the heightmap in grayscale with the water mask overlaid in color (toggleable), plus a marker for the camera's position and direction.
- **Clicking the minimap swaps it** with the 3D view, so the flat map goes full-window and the 3D view becomes the inset.

### 6.4 Controls (user confirmed this list)

- **Seed:** number input + randomize button.
- **Terrain:** mountain height, ruggedness, ridge sharpness, feature scale (how big the mountains are), low-ground/flatland amount.
- **Erosion:** strength, duration (simulation steps), sediment deposition, thermal smoothing.
- **Water:** rainfall (how many rivers form), river width, lake fill (how readily basins become lakes), minimum lake size, **sea level**.
- **Quality:** base quality (2048 / 4096). **This is a generation setting, not an export setting (Claude's call).** Generate runs at the chosen quality, the preview shows that result, and Export reuses the same base pass. That way the exported rivers and lakes are exactly the ones the user saw. Changing it requires a new Generate.
- **Island:** on/off toggle + coastline width.
  - **On:** the map is guaranteed to have water on all four sides. Terrain falls below sea level toward the edges over the coastline width.
  - **Off:** nothing is enforced at the edges. Land does whatever noise and erosion produce, which may include low ground below sea level. It is **not** forced to be land at the edges.
  - Sea level applies in both modes (Claude's call).
- **Export:** output resolution (1 m / 2 m), tile size, height format (EXR / R16).

### 6.4.1 Vertical reference (Claude's call)

- All heights are **absolute meters**, with **sea level at y = 0** in Godot. Terrain below sea level has negative heights.
- The **mountain height** slider sets the terrain's elevation scale in meters. It's the only height-scale control.
- There's no separate "height range" setting. For R16, the packing range is computed automatically from the terrain's actual min/max. The resulting scale and offset are written into `README.txt` and `world.json` for the Terrain3D import settings. EXR stores meters directly.
- The sea-level slider moves the terrain relative to y = 0, so the ocean surface is always at y = 0. That height is recorded in `world.json`.

### 6.5 Working loop (proposed by Claude, accepted by the user)

- Changing terrain-shape sliders gives a **near-instant rough preview** at low resolution (around 512²), with noise only and no erosion.
- **Generate** runs the full base pass. It shows a progress bar, can be cancelled, and updates the 3D view and minimap when done.
- **Export** is a separate, slower step. It produces a zip download and shows progress.
- Seed and settings can be **copied as a preset string** and pasted back in. The last settings are restored on reload, stored in localStorage and wrapped so failures are harmless.

### 6.6 Export bundle (user asked for all of it)

A single zip containing:

- `heights/`: one file per tile, in **EXR 32-bit float** (heights in meters) or **R16** (normalized to the height range). Tiles align with Terrain3D regions, at 1024² by default. A 10240² map at 1024 tiles comes to 10×10 tiles. Tiles must be seamless.
- `water/`: one **RGB PNG per tile**, matching the height tiles:
  - **R = rivers, G = lakes, B = ocean**
  - 8-bit values with soft edges (0–255), not hard on/off
- `lakes.json`: one entry per lake with an id, **surface height** (m), bounding box, and outline or area. Positions are in world meters.
- `rivers.json`: one entry per river with an id and an ordered **centerline polyline**. Each point carries position (x, z), **water surface height**, and width. It also records what the river flows into (lake id, ocean, map edge, or another river) for tributaries.
- `world.json` (Claude's call): map size in meters, vertex spacing, tile size and grid, ocean surface height (0), R16 scale/offset if used, and the import position the tiles assume.
- `preset.txt`: seed + all slider values, including base quality, enough to regenerate the same map.
- `README.txt`: how to import into Terrain3D, including vertex spacing, height scale/offset for R16, region size, and the import position the tiles assume.

- `godot/terrain3d_import.gd`: the one-click import script (see §6.7).

All world coordinates in the JSON must use the same origin and units as the imported terrain, so lakes and rivers line up in Godot without manual offsets.

### 6.7 Getting it into Godot (user decision, with Claude's assessment)

The user preferred **one full-size heightmap file** unless that would cause problems, with **tiles + an import script** as the fallback.

**Assessment (Claude's call): go with tiles + import script.**
- A single 10240² EXR is ~400 MB on disk.
- Godot's EXR loader expands to RGBA float on load, which is about 1.6 GB of RAM before Terrain3D even starts slicing it into regions.
- In the browser, building and zipping one 400 MB file also doubles peak memory.

That's borderline-to-risky on a laptop, while tiles stay small at every step.

**The import script:**
- A `@tool` GDScript (an EditorScript or a small editor plugin) shipped inside the zip.
- The user points it at the unzipped folder and a Terrain3D node, then runs it once.
- It reads `world.json` and imports every height tile at its correct position, with the correct vertex spacing and R16 scale/offset when relevant.
- It reports progress and errors in the Output panel.
- It does **not** build water. That stays a later feature.
- **Target version:** the current stable Terrain3D 1.x release at implementation time. The user didn't name a version. The builder pins the exact version tested against in `README.txt`.

## 7. Rivers and lakes: hard requirements

Rivers are the user's top concern.

### 7.1 Never uphill (guaranteed, enforced by tests)

- After erosion, depressions in the base heightmap are resolved, for example with a priority-flood algorithm. Each depression either becomes a **lake** (big and deep enough, per the lake fill and minimum lake size sliders) or is **filled**, raising the terrain slightly so water drains through. Afterwards every cell has a non-ascending path to an outlet: a lake, the ocean, or the map edge.
- Rivers are traced along that drainage path, from source to outlet.
- The **carved riverbed descends steadily** along every river at full resolution. Exported **water surface heights never increase** from one point to the next.
- A lake's outlet river starts exactly at the lake's surface height. A tributary joins its main river at or above the main river's water height at that point.
- **Automated test:** generate many seeds × settings and assert that, along every river, (a) bed height and (b) exported water height never increase from source to mouth. Small float tolerance only.
  - **Where it runs (Claude's call):** keep hydrology, river extraction, and carving as CPU code that takes an eroded heightmap as input. Vitest in Node then runs the "never uphill" check across many synthetic heightmaps and stored fixture heightmaps captured from real GPU erosion runs.
  - A separate browser-mode end-to-end test, with the full GPU pipeline across several seeds, runs **locally on a machine with a GPU**. GPU-less CI isn't required.

### 7.2 Natural-looking

- Rivers come from **flow accumulation** on the eroded terrain, so they sit in valley floors.
- **Branching networks:** tributaries merge into larger rivers.
- **Width and depth scale with accumulated flow**, so a thin creek grows into a wide river.
- **Gentle meanders on flat ground**, straighter runs on steep ground. Meanders must not break the downhill rule or climb out of the valley.
- **Beveled banks**, not a hard-edged trench.
- A **minimum flow threshold**, tied to the rainfall slider, sets where a stream begins. That keeps hillsides from filling with tiny streams.
- Polylines are smoothed so the exported curves are usable as Godot Path3D curves, with no jagged 8-direction steps.

### 7.3 Ocean

- Ocean cells sit below sea level and connect to the ocean body at the map edge. Low areas enclosed inland are treated as lakes, not ocean (Claude's call).
- In island mode, all four edges are guaranteed to be ocean.

## 8. Reproducibility

- The same seed + settings must produce the same terrain **on the same machine and browser**.
- GPU floating-point results can differ slightly between GPU vendors and drivers, so identical output across different machines is a goal but not a guarantee. The design should avoid sources of nondeterminism it controls: no racy atomics in erosion, and no `Math.random` without the seed. **(Claude's call.)**

## 9. Performance targets (Claude's proposed targets; builder may refine)

On the reference RTX 3050 Laptop GPU (4 GB VRAM):

- Live preview updates in well under a second while dragging sliders.
- **Generate** at 2048² finishes in tens of seconds, not minutes.
- **Export** at 1 m/px completes in a few minutes with steady progress and a responsive page.
- No single GPU buffer exceeds the device's limits. Ask the adapter for the limits it supports, and design the full-resolution pass to work within the defaults.
- Peak JS memory stays reasonable during export: stream tiles into the zip instead of holding all 100 tiles plus the full-resolution map at once, where possible.

## 10. Left to the builder

- Exact noise recipe (fBm, ridged multifractal, domain warping, and so on) and how each slider maps onto it.
- Erosion algorithm details and parameter mapping, as long as it runs on the GPU and meets the look and performance goals.
- Which hydrology steps run on the GPU and which run on the CPU in a worker. At 2048–4096², CPU priority-flood and flow accumulation in a worker are acceptable.
- River carving method at full resolution: GPU distance-to-polyline per tile, CPU rasterization, or similar.
- How detail noise avoids seams at tile edges (overlapping borders, globally seeded noise, and so on).
- Three.js mesh LOD and resolution for the preview.
- Exact EXR flavor (uncompressed is fine) and R16 byte order, **verified against the current Terrain3D importer**.
- Exact Terrain3D coordinate convention for tile placement and JSON coordinates, **verified against the current Terrain3D version** and documented in the README.
- Visual styling of the UI.
- Code structure. It should leave room for drawing tools later, for example by keeping the "terrain inputs → base pass" boundary clean so a painted mask can join the inputs.

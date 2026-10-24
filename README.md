# Terrain Generator

A local browser tool for generating a 10.24 × 10.24 km terrain for Godot Terrain3D. WebGPU shapes and erodes the terrain; a worker traces rivers, lakes and ocean. Export produces seamless EXR or R16 height tiles, RGB water masks, water geometry JSON, a preset and a Godot import script.

## Run

Use a current Chrome or Edge with WebGPU enabled and a recent Node.js version compatible with Vite 8.

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. The tool runs locally; terrain and presets stay in your browser. Settings are saved in localStorage when you change them.

## Use

1. Pick a seed and adjust Terrain or Island controls for a rough preview.
2. Press **Generate terrain** to run erosion and hydrology. Erosion, Water and Quality settings take effect on the next Generate. Cancel stops the current run.
3. Drag to orbit, scroll to zoom, and right-drag to pan. The bottom-left map can be resized. Click it or **Swap views** to exchange the map and 3D view. **Water on/off** changes the map overlay.
4. In Export, select 1 or 2 m spacing, a tile size, and EXR or R16. Press **Export bundle** to export the last completed generation with these output options. Changed terrain settings require another Generate to appear in the export.
5. Use **Copy preset** and the preset text box to reproduce settings. Invalid presets leave existing settings intact.
6. **Reset defaults** restores the seed, terrain, water, quality and export controls, saves them, and starts a fresh rough preview. It also discards queued work and the previous export result; press Generate before exporting again.

Defaults balance broad valleys with pronounced spurs and knolls: 1000 m elevation scale, 3 km features, ruggedness 0.5, ridge sharpness 0.55 and flatland 0.25. Medium-scale nested ridges add variation to valley walls and uplands. Lower default thermal smoothing (0.2) and deposition preserve this relief through erosion. Larger feature-scale values create broader landforms. Wet lake outlets follow downhill drainage to lower lakes, ocean, the map edge or a larger river even when they fall below the ordinary stream threshold. Rainfall zero disables rivers.

Thermal smoothing at zero now disables both hillslope diffusion and thermal material transfer. Turn erosion strength off as well to preserve the initial shape. Landform regression tests check retained medium-scale relief through erosion and hydrology as well as an upper bound on pixel-scale roughness.

The 3D view uses muted land colors and a continuous river overlay; the map retains grayscale heights. Preview river lines have a minimum visible footprint. Exported river widths and water masks retain their world-meter scale. These preview land colors are not exported as terrain textures.

The revised shaping algorithm changes the landforms produced by older presets; their settings still load. Use Reset defaults to try the gentler starting point instead of previously saved values.

At 2 m spacing, 2048-pixel tiles are unavailable because they do not divide the 5120-pixel output. 4096 quality changes the generation resolution; export reuses that generation.

## Godot import

The bundle targets Terrain3D **1.0.2**. Its importer was checked with Godot **4.7.2** using both EXR and R16 at 2 m spacing.

Unzip into your Godot project, add and select a Terrain3D node, open the bundle's `godot/terrain3d_import.gd`, and choose **File > Run** in the Script editor. Set the Terrain3D data directory and save the scene afterwards. The archive's `README.txt` explains coordinates and R16 ranges. The script imports terrain; water masks and vector data are supplied for your own water setup.

The automated Godot checks exercised `import_bundle`; selecting a node and launching the EditorScript still requires a manual editor check.

## Validation

```sh
npm test
npm run test:gpu
npm run build
node tests/e2e/verify-app.mjs
```

GPU tests launch installed Chrome through Playwright and require GPU access. They cover shaping, erosion, detail, streaming export, browser controls and the full 2048-resolution pipeline across five seeds with island mode on and off. A further stress case uses 3000 m mountains, narrow rivers and 1 m output. River tests check both continuous water/bed profiles and actual carved output pixels. A sparse global drainage pass propagates low channel pixels downstream across tile boundaries.

The standalone app check starts and stops its own local server, exercises swapping, water toggle, invalid presets, reset and default generation, and writes a screenshot and timings to ignored `test-results/`. Set `TERRAIN_REVIEW_SEEDS=1` to also capture seeds 2 and 3. For full-export and 4096-quality performance checks in PowerShell:

```powershell
$env:TERRAIN_PERF = '1'
node tests/e2e/verify-app.mjs
```

That check replaces the browser's save picker with a counting sink, so it exercises all export tiles and compression without writing a large zip. It also checks browser timer activity during export and settings restoration after reload.

## Performance

Measured on the local reference laptop in Chrome on October 24, 2026, using the development build and seed 1. The original baseline is below; the gentler terrain revision has also been checked at 2048 in about 7 seconds. These are measured examples, not limits for other hardware or settings.

| Operation | Measured time |
|---|---:|
| Initial page load through rough preview | About 0.9 s |
| Generate at 2048, including erosion and worker hydrology | About 6 s |
| Generate at 4096, including erosion and worker hydrology | About 35 s |
| Full 1 m EXR export, 100 tiles, counting sink | About 19 s |

The measured archive contained 340,770,267 bytes. A 50 ms browser timer continued throughout export; its longest observed gap was 73.5 ms. The standalone app check reported no uncaught page errors.

Per-tile GPU generation and streaming zip export avoid allocating a single full-resolution GPU height buffer. Without the browser's file-system save API, export falls back to a Blob download, which buffers the archive in browser memory.

The production build currently reports a bundle-size advisory for Three.js and Tweakpane; compilation succeeds.

import './style.css';
import { Pipeline, type PipelineResult } from './app/pipeline';
import { decodePreset, encodePreset, loadSavedParams, saveParams } from './core/params';
import { initGpu, WebGpuUnavailableError } from './gpu/device';
import { generateTerrain } from './gpu/terrain';
import { erode } from './gpu/erosion';
import { runHydrologyInWorker } from './hydro/client';
import { openSaveSink } from './export/sink';
import { exportBundle } from './export/exporter';
import { colorizeTerrain } from './ui/colorize';
import { createViewport } from './ui/viewport';
import { createMinimap } from './ui/minimap';
import { createPanel } from './ui/panel';
import { createStatus } from './ui/status';

async function main() {
  const app = document.getElementById('app')!;
  app.innerHTML = `<div id="scene"></div><header><span class="eyebrow">TERRAIN LAB</span><h1>A world from a seed.</h1><p>10.24 × 10.24 km · built for Terrain3D</p></header><aside id="settings" aria-label="Terrain controls"></aside><div id="inset"><button id="swap" aria-label="Swap map and 3D view">Swap views ↗</button><div id="inset-content"></div></div><div id="status"></div><footer><span id="result-label">Starting preview…</span><span>Drag to orbit · scroll to zoom · right-drag to pan</span></footer>`;
  const loaded = loadSavedParams();
  const params = loaded.params;
  const pipeline = new Pipeline({ initGpu, generateTerrain, erode, runHydrologyInWorker, openSaveSink, exportBundle });
  const status = createStatus(document.getElementById('status')!, () => pipeline.cancel());
  if (loaded.warning) status.notice(loaded.warning);
  try { const probe = await initGpu(); probe.device.destroy(); }
  catch (error) {
    app.replaceChildren();
    const message = document.createElement('div'); message.className = 'unavailable';
    const title = document.createElement('h1'); title.textContent = error instanceof WebGpuUnavailableError ? 'This app needs WebGPU — use current Chrome or Edge' : 'Unable to start the GPU';
    const detail = document.createElement('p'); detail.textContent = error instanceof Error ? error.message : String(error);
    message.append(title, detail); app.append(message); return;
  }
  const scene = document.getElementById('scene')!, inset = document.getElementById('inset-content')!;
  const viewport = createViewport(scene);
  let swapped = false, showWater = true, result: PipelineResult | undefined, generated = false;
  const label = document.getElementById('result-label')!;
  const swap = () => {
    swapped = !swapped; viewport.setContainer(swapped ? inset : scene); minimap.setContainer(swapped ? scene : inset);
    document.getElementById('swap')!.textContent = swapped ? 'Back to 3D ↗' : 'Swap views ↗';
  };
  const renderMap = () => {
    if (!result) return;
    const grid = result.hydro?.terrain ?? result.base;
    minimap.setImage(colorizeTerrain(grid, result.hydro, showWater), grid.width, grid.height);
  };
  const minimap = createMinimap(inset, swap, (visible) => { showWater = visible; renderMap(); });
  document.getElementById('swap')!.addEventListener('click', swap);
  const shapeKeys = new Set(['seed', 'mountainHeight', 'ruggedness', 'ridgeSharpness', 'featureScale', 'flatland', 'island', 'coastlineWidth', 'seaLevel']);
  const panel = createPanel(document.getElementById('settings')!, params, {
    onChange(p, key) {
      saveParams(p);
      if (shapeKeys.has(key)) pipeline.preview(p);
      label.textContent = ['outputSpacing', 'tileSize', 'heightFormat'].includes(key) && generated
        ? 'Export options updated · exports the last generated terrain'
        : 'Settings changed · press Generate to update the export';
    },
    onGenerate: () => { void pipeline.generate(params); },
    onCancel: () => pipeline.cancel(),
    onExport: () => { void pipeline.export(params); },
    onRandomSeed() {
      params.seed = crypto.getRandomValues(new Uint32Array(1))[0]; panel.setParams(params); saveParams(params); pipeline.preview(params);
    },
    async onCopyPreset() {
      const value = encodePreset(params);
      try { await navigator.clipboard.writeText(value); status.notice('Preset copied.'); }
      catch { panel.showPreset(value); status.notice('Select and copy the preset from the text box.'); }
    },
    onPastePreset(value) {
      try { panel.setParams(decodePreset(value)); saveParams(params); pipeline.preview(params); }
      catch { status.notice("That preset couldn't be read"); }
    },
  });
  pipeline.onState((s) => { status.setState(s); panel.setBusy(s.kind === 'busy', generated); });
  pipeline.onNotice((message) => status.notice(message));
  pipeline.onResult((r) => {
    result = r;
    const grid = r.hydro?.terrain ?? r.base;
    viewport.setTerrain(grid, colorizeTerrain(grid, r.hydro)); renderMap();
    generated ||= r.kind === 'generate'; panel.setBusy(false, generated);
    label.textContent = r.kind === 'generate' ? `Generated · seed ${r.params.seed} · ${r.hydro!.rivers.length} rivers · ${r.hydro!.lakes.length} lakes` : `Rough preview · seed ${r.params.seed} · press Generate for erosion and water`;
  });
  let frame = 0, last = 0;
  const tick = (now: number) => {
    if (now - last > 100) { minimap.setCamera(viewport.getCameraPose()); last = now; }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); pipeline.cancel(); viewport.dispose(); minimap.dispose(); panel.dispose(); }, { once: true });
  pipeline.preview(params);
}
void main().catch((error) => {
  const app = document.getElementById('app')!;
  const message = document.createElement('p'); message.className = 'unavailable'; message.textContent = `Unable to start: ${error instanceof Error ? error.message : String(error)}`;
  app.replaceChildren(message);
});

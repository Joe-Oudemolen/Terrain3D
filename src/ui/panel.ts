import { Pane } from 'tweakpane';
import { clampParams, PARAM_RANGES, type TerrainParams } from '../core/params';

export interface PanelHandlers {
  onChange(p: TerrainParams, key: keyof TerrainParams): void;
  onGenerate(): void; onCancel(): void; onExport(): void;
  onRandomSeed(): void; onCopyPreset(): void; onPastePreset(s: string): void;
  onResetDefaults(): void;
}

export function createPanel(container: HTMLElement, params: TerrainParams, handlers: PanelHandlers) {
  const pane = new Pane({ container, title: 'Terrain settings' });
  const seed = pane.addFolder({ title: 'Seed' });
  seed.addBinding(params, 'seed', { label: 'Seed', step: 1 });
  seed.addButton({ title: 'Randomize seed' }).on('click', handlers.onRandomSeed);
  const groups: [string, [keyof typeof PARAM_RANGES, string][]][] = [
    ['Terrain', [['mountainHeight', 'Height (m)'], ['ruggedness', 'Ruggedness'], ['ridgeSharpness', 'Ridges'], ['featureScale', 'Scale (km)'], ['flatland', 'Flatland']]],
    ['Erosion', [['erosionStrength', 'Strength'], ['erosionDuration', 'Duration'], ['sedimentDeposition', 'Deposition'], ['thermalSmoothing', 'Smoothing']]],
    ['Water', [['rainfall', 'Rainfall'], ['riverWidth', 'River width'], ['lakeFill', 'Lake fill'], ['minLakeSize', 'Min lake (m²)'], ['seaLevel', 'Sea level']]],
  ];
  for (const [title, fields] of groups) {
    const folder = pane.addFolder({ title, expanded: title === 'Terrain' });
    for (const [key, label] of fields) folder.addBinding(params, key, {
      label, ...PARAM_RANGES[key], step: key === 'mountainHeight' || key === 'minLakeSize' ? 1 : 0.01,
    });
  }
  const island = pane.addFolder({ title: 'Island', expanded: false });
  island.addBinding(params, 'island', { label: 'Island' });
  const coast = island.addBinding(params, 'coastlineWidth', { label: 'Coast (km)', ...PARAM_RANGES.coastlineWidth, step: 0.01 });
  const quality = pane.addFolder({ title: 'Quality', expanded: false });
  quality.addBinding(params, 'baseQuality', { label: 'Base size', options: { '2048 (default)': 2048, '4096 (high)': 4096 } });
  const exp = pane.addFolder({ title: 'Export', expanded: false });
  exp.addBinding(params, 'outputSpacing', { label: 'Spacing', options: { '1 m / px': 1, '2 m / px': 2 } });
  let tileBinding = exp.addBinding(params, 'tileSize', { label: 'Tile size', options: params.outputSpacing === 2 ? { '512': 512, '1024': 1024 } : { '512': 512, '1024': 1024, '2048': 2048 } });
  exp.addBinding(params, 'heightFormat', { label: 'Heights', options: { 'EXR (float)': 'exr', 'R16 (raw)': 'r16' } });
  let tileSpacing = params.outputSpacing;
  const sync = () => {
    coast.disabled = !params.island;
    if (tileSpacing !== params.outputSpacing) {
      tileSpacing = params.outputSpacing; tileBinding.dispose();
      tileBinding = exp.addBinding(params, 'tileSize', { label: 'Tile size', options: params.outputSpacing === 2 ? { '512': 512, '1024': 1024 } : { '512': 512, '1024': 1024, '2048': 2048 } });
    }
  };
  pane.on('change', (event) => {
    if (!('key' in event.target)) return;
    const key = event.target.key as keyof TerrainParams;
    Object.assign(params, clampParams(params)); sync(); pane.refresh(); handlers.onChange({ ...params }, key);
  });
  pane.addButton({ title: 'Generate terrain' }).on('click', handlers.onGenerate);
  const exportButton = pane.addButton({ title: 'Export bundle', disabled: true }); exportButton.on('click', handlers.onExport);
  const cancel = pane.addButton({ title: 'Cancel', hidden: true }); cancel.on('click', handlers.onCancel);
  const presets = pane.addFolder({ title: 'Presets', expanded: false });
  presets.addButton({ title: 'Copy preset' }).on('click', handlers.onCopyPreset);
  pane.addButton({ title: 'Reset defaults' }).on('click', handlers.onResetDefaults);
  const preset = document.createElement('textarea');
  preset.placeholder = 'Paste a preset here'; preset.setAttribute('aria-label', 'Preset string');
  const apply = document.createElement('button'); apply.textContent = 'Apply preset';
  apply.addEventListener('click', () => handlers.onPastePreset(preset.value.trim()));
  const presetBox = document.createElement('div'); presetBox.className = 'preset-box'; presetBox.append(preset, apply); container.append(presetBox);
  sync();
  return {
    setParams(p: TerrainParams) { Object.assign(params, clampParams(p)); sync(); pane.refresh(); },
    setBusy(busy: boolean, canExport: boolean) { exportButton.disabled = busy || !canExport; cancel.hidden = !busy; },
    coastlineDisabled: () => coast.disabled,
    showPreset(value: string) { preset.value = value; preset.focus(); preset.select(); },
    dispose() { pane.dispose(); presetBox.remove(); },
  };
}

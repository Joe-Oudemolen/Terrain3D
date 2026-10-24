import { expect, test } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { createPanel } from '../../src/ui/panel';
import { createStatus } from '../../src/ui/status';
import { createMinimap } from '../../src/ui/minimap';

test('panel restores presets, constrains tiles, and disables coastline unless island is enabled', () => {
  const host = document.createElement('div'); document.body.append(host);
  const p = { ...DEFAULT_PARAMS };
  let changedKey = '';
  let reset = false;
  const panel = createPanel(host, p, {
    onChange(_p, key) { changedKey = key; }, onGenerate() {}, onCancel() {}, onExport() {}, onRandomSeed() {}, onCopyPreset() {}, onPastePreset() {},
    onResetDefaults() { reset = true; },
  });
  expect(host.textContent).toContain('Terrain');
  expect(panel.coastlineDisabled()).toBe(true);
  host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  expect(changedKey).toBe('island');
  expect(panel.coastlineDisabled()).toBe(false);
  [...host.querySelectorAll('button')].find(b => b.textContent === 'Reset defaults')!.click();
  expect(reset).toBe(true);
  panel.setParams({ ...p, island: true, outputSpacing: 2, tileSize: 2048 });
  expect(p.tileSize).toBe(1024);
  expect(panel.coastlineDisabled()).toBe(false);
  panel.dispose(); host.remove();
});

test('status exposes progress, cancellation, retry, and dismissible notices', () => {
  const host = document.createElement('div'); document.body.append(host);
  let cancelled = false, retried = false;
  const status = createStatus(host, () => { cancelled = true; });
  status.setState({ kind: 'busy', task: 'generate', progress: 0.5 });
  expect(host.querySelector('progress')?.value).toBe(0.5);
  host.querySelector<HTMLButtonElement>('button')!.click(); expect(cancelled).toBe(true);
  status.setState({ kind: 'error', message: 'Example error', retry: () => { retried = true; } });
  host.querySelector<HTMLButtonElement>('button')!.click(); expect(retried).toBe(true);
  status.notice('Saved settings unavailable'); expect(host.textContent).toContain('Saved settings unavailable');
  host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click();
  expect(host.querySelector<HTMLElement>('.notice')!.hidden).toBe(true); host.remove();
});

test('water toggle does not swap the minimap', () => {
  const host = document.createElement('div'); document.body.append(host);
  let swaps = 0, visible = true;
  const map = createMinimap(host, () => { swaps++; }, (b) => { visible = b; });
  host.querySelector<HTMLButtonElement>('button')!.click();
  expect(swaps).toBe(0); expect(visible).toBe(false);
  host.querySelector('canvas')!.click(); expect(swaps).toBe(1);
  map.dispose(); host.remove();
});

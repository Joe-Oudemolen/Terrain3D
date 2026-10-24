import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const server = await createServer({ server: { host: '127.0.0.1', port: 5178, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(300000);
const errors = [];
await page.addInitScript(() => {
  window.__exportCheck = { bytes: 0, closed: false, ticks: 0, maxGapMs: 0 };
  window.showSaveFilePicker = async () => ({ createWritable: async () => ({
    write: async (chunk) => { window.__exportCheck.bytes += chunk.byteLength; },
    close: async () => { window.__exportCheck.closed = true; }, abort: async () => {},
  }) });
});
page.on('pageerror', (error) => errors.push(error.message));
const timings = {};
try {
  let start = performance.now();
  await page.goto('http://127.0.0.1:5178');
  await page.waitForFunction(() => document.querySelector('#result-label')?.textContent?.startsWith('Rough preview'), { timeout: 30000 });
  timings.startupPreviewMs = Math.round(performance.now() - start);
  assert.equal(await page.locator('#scene canvas').count(), 1);
  await page.getByRole('button', { name: 'Swap map and 3D view' }).click();
  assert.equal(await page.locator('#scene .minimap').count(), 1);
  await page.getByRole('button', { name: 'Water on', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Water off', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Swap map and 3D view' }).click();
  await page.getByRole('textbox', { name: 'Preset string' }).fill('invalid preset');
  await page.getByRole('button', { name: 'Apply preset', exact: true }).click();
  await page.getByText("That preset couldn't be read", { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Dismiss notice' }).click();
  await page.getByRole('button', { name: 'Reset defaults', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#result-label')?.textContent?.startsWith('Rough preview'));
  assert.equal(await page.getByRole('button', { name: 'Export bundle', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => JSON.parse(atob(localStorage.getItem('terrain-gen:params').replace(/-/g, '+').replace(/_/g, '/'))).mountainHeight), 650);
  await page.getByRole('button', { name: 'Dismiss notice' }).click();
  start = performance.now();
  await page.getByRole('button', { name: 'Generate terrain', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#result-label')?.textContent?.startsWith('Generated'), { timeout: 240000 });
  timings.generate2048Ms = Math.round(performance.now() - start);
  console.log('Default generation:', timings.generate2048Ms, 'ms');
  timings.result = await page.locator('#result-label').textContent();
  await page.getByRole('button', { name: 'Water off', exact: true }).click();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/app.png' });
  if (process.env.TERRAIN_REVIEW_SEEDS === '1') {
    timings.seedReview = [];
    for (const seed of [2, 3]) {
      const preset = await page.evaluate((seed) => {
        const raw = localStorage.getItem('terrain-gen:params');
        const p = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
        return btoa(JSON.stringify({ ...p, seed }));
      }, seed);
      await page.getByRole('textbox', { name: 'Preset string' }).fill(preset);
      await page.getByRole('button', { name: 'Apply preset', exact: true }).click();
      await page.waitForFunction(seed => document.querySelector('#result-label')?.textContent?.startsWith(`Rough preview · seed ${seed}`), seed);
      await page.getByRole('button', { name: 'Generate terrain', exact: true }).click();
      await page.waitForFunction(seed => document.querySelector('#result-label')?.textContent?.startsWith(`Generated · seed ${seed}`), seed);
      timings.seedReview.push(await page.locator('#result-label').textContent());
      await page.screenshot({ path: `test-results/app-seed-${seed}.png` });
    }
  }
  if (process.env.TERRAIN_PERF === '1') {
    await page.evaluate(() => {
      let last = performance.now();
      window.__tick = setInterval(() => { const now = performance.now(); window.__exportCheck.maxGapMs = Math.max(window.__exportCheck.maxGapMs, now - last); last = now; window.__exportCheck.ticks++; }, 50);
    });
    start = performance.now();
    await page.getByRole('button', { name: 'Export bundle', exact: true }).click();
    await page.waitForFunction(() => window.__exportCheck.closed, { timeout: 300000 });
    timings.export1mExrMs = Math.round(performance.now() - start);
    console.log('Full 1 m EXR export:', timings.export1mExrMs, 'ms');
    timings.export = await page.evaluate(() => { clearInterval(window.__tick); return window.__exportCheck; });
    assert.ok(timings.export.bytes > 1000000);
    assert.ok(timings.export.ticks > 0);
    const preset = await page.evaluate(() => {
      const raw = localStorage.getItem('terrain-gen:params');
      const p = raw ? JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))) : {};
      return btoa(JSON.stringify({ v: 1, ...p, baseQuality: 4096 }));
    });
    await page.getByRole('textbox', { name: 'Preset string' }).fill(preset);
    await page.getByRole('button', { name: 'Apply preset', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#result-label')?.textContent?.startsWith('Rough preview'));
    start = performance.now();
    await page.getByRole('button', { name: 'Generate terrain', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#result-label')?.textContent?.startsWith('Generated'), { timeout: 300000 });
    timings.generate4096Ms = Math.round(performance.now() - start);
    console.log('High-quality generation:', timings.generate4096Ms, 'ms');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#result-label')?.textContent?.startsWith('Rough preview'));
    assert.equal(await page.evaluate(() => JSON.parse(atob(localStorage.getItem('terrain-gen:params').replace(/-/g, '+').replace(/_/g, '/'))).baseQuality), 4096);
  }
  assert.equal(await page.getByRole('button', { name: 'Export bundle', exact: true }).isDisabled(), process.env.TERRAIN_PERF === '1');
  await page.getByRole('button', { name: 'Reset defaults', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#result-label')?.textContent?.startsWith('Rough preview · seed 1'));
  assert.equal(await page.getByRole('button', { name: 'Export bundle', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
  await writeFile('test-results/app-verification.json', JSON.stringify({ timings, errors }, null, 2));
  console.log(JSON.stringify({ timings, errors }));
} catch (error) {
  console.log('App state on failure:', await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); await server.close(); }

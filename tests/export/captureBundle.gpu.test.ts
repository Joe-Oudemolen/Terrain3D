import { test } from 'vitest';
import { commands } from 'vitest/browser';
import type { Grid } from '../../src/core/grid';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { initGpu } from '../../src/gpu/device';
import { exportBundle } from '../../src/export/exporter';
import type { ByteSink } from '../../src/export/sink';
import { runHydrology } from '../../src/hydro/hydrology';
import fixtureUrl from '../fixtures/eroded_s1_512.f32?url';

// Skipped by default. Writes full 2 m / tile 1024 bundles for manual Godot import verification:
//   VITE_CAPTURE_BUNDLE=node_modules/.bundles (dir inside the project root, vite fs.strict) npm run test:gpu -- captureBundle
const OUT = import.meta.env.VITE_CAPTURE_BUNDLE as string | undefined;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

test.runIf(!!OUT && OUT !== '1')(
  'capture 2 m bundles (exr + r16)',
  async () => {
    const ctx = await initGpu();
    const base: Grid = {
      width: 512,
      height: 512,
      cellSize: 20,
      data: new Float32Array(await (await fetch(fixtureUrl)).arrayBuffer()),
    };
    for (const heightFormat of ['exr', 'r16'] as const) {
      const P = { ...DEFAULT_PARAMS, outputSpacing: 2 as const, tileSize: 1024 as const, heightFormat };
      const hydro = runHydrology(base, P);
      const chunks: Uint8Array[] = [];
      const sink: ByteSink = {
        async write(c) {
          chunks.push(c);
        },
        async close() {},
        async abort() {},
      };
      await exportBundle(ctx, hydro, P, sink);
      const path = `${OUT}/bundle_${heightFormat}.zip`;
      // Append in ~6 MB pieces to keep each command payload small.
      let first = true;
      let pending: Uint8Array[] = [];
      let size = 0;
      const flush = async () => {
        const buf = new Uint8Array(size);
        let o = 0;
        for (const c of pending) {
          buf.set(c, o);
          o += c.length;
        }
        await commands.writeFile(path, toBase64(buf), { encoding: 'base64', flag: first ? 'w' : 'a' } as never);
        first = false;
        pending = [];
        size = 0;
      };
      for (const c of chunks) {
        pending.push(c);
        size += c.length;
        if (size >= 6_000_000) await flush();
      }
      if (size > 0) await flush();
    }
    ctx.device.destroy();
  },
  600_000,
);

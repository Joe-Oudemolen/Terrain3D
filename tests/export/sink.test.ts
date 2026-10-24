import { expect, test } from 'vitest';
import { openSaveSink } from '../../src/export/sink';

test('dismissed picker returns null', async () => {
  const w = { showSaveFilePicker: () => Promise.reject(new DOMException('x', 'AbortError')) };
  expect(await openSaveSink('a.zip', w as any)).toBeNull();
});

test('picker errors other than AbortError propagate', async () => {
  const w = { showSaveFilePicker: () => Promise.reject(new DOMException('x', 'SecurityError')) };
  await expect(openSaveSink('a.zip', w as any)).rejects.toThrow('x');
});

test('picker sink streams chunks to the writable, closes, and aborts', async () => {
  const log: string[] = [];
  const writable = {
    write: async (c: Uint8Array) => void log.push(`w${c.length}`),
    close: async () => void log.push('close'),
    abort: async () => void log.push('abort'),
  };
  const w = { showSaveFilePicker: async () => ({ createWritable: async () => writable }) };
  const s = (await openSaveSink('a.zip', w as any))!;
  await s.write(new Uint8Array(3));
  await s.write(new Uint8Array(5));
  await s.close();
  expect(log).toEqual(['w3', 'w5', 'close']);
  const s2 = (await openSaveSink('a.zip', w as any))!;
  await s2.abort();
  expect(log.at(-1)).toBe('abort');
});

test('without a picker, close downloads a Blob via an anchor', async () => {
  const clicks: { href: string; download: string }[] = [];
  const doc = {
    createElement: () => {
      const a = { href: '', download: '', click() { clicks.push({ href: a.href, download: a.download }); }, remove() {} };
      return a;
    },
    body: { appendChild() {} },
  };
  const w = { document: doc };
  const s = (await openSaveSink('terrain.zip', w as any))!;
  await s.write(new Uint8Array([1, 2]));
  await s.close();
  expect(clicks).toHaveLength(1);
  expect(clicks[0].download).toBe('terrain.zip');
  expect(clicks[0].href).toMatch(/^blob:/);
});

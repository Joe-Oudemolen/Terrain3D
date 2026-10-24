export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface SaveFileHandle {
  createWritable(): Promise<{
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
}
type PickerWindow = { showSaveFilePicker?: (o: unknown) => Promise<SaveFileHandle> };

/**
 * Save sink for the export zip. Uses the File System Access API when present (chunks stream to disk,
 * returns null if the user dismisses the picker); otherwise buffers in a Blob and downloads on close.
 */
export async function openSaveSink(suggestedName: string, w: Window = window): Promise<ByteSink | null> {
  const picker = (w as unknown as PickerWindow).showSaveFilePicker;
  if (picker) {
    let handle: SaveFileHandle;
    try {
      handle = await picker.call(w, {
        suggestedName,
        types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      throw e;
    }
    const writable = await handle.createWritable();
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  }

  let parts: Uint8Array[] = [];
  return {
    async write(chunk) {
      parts.push(chunk);
    },
    async close() {
      const blob = new Blob(parts as BlobPart[], { type: 'application/zip' });
      parts = [];
      const url = URL.createObjectURL(blob);
      const a = w.document.createElement('a');
      a.href = url;
      a.download = suggestedName;
      w.document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async abort() {
      parts = [];
    },
  };
}

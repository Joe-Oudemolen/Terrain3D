import { WORLD_SIZE_M } from '../core/grid';
import type { CameraPose } from './viewport';

export function worldToMinimap(x: number, z: number, canvasPx: number): [number, number] {
  return [x / WORLD_SIZE_M * canvasPx, z / WORLD_SIZE_M * canvasPx];
}

export function createMinimap(container: HTMLElement, onSwap: () => void, onWaterChange?: (visible: boolean) => void) {
  const root = document.createElement('div');
  root.className = 'minimap';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Terrain map; click to swap with 3D view');
  const ctx = canvas.getContext('2d')!;
  const source = document.createElement('canvas');
  const toggle = document.createElement('button');
  toggle.className = 'water-toggle';
  toggle.textContent = 'Water on';
  toggle.setAttribute('aria-pressed', 'true');
  root.append(canvas, toggle);
  let water = true;
  let pose: CameraPose | undefined;
  const draw = () => {
    const w = Math.max(1, root.clientWidth), h = Math.max(1, root.clientHeight);
    canvas.width = w; canvas.height = h;
    ctx.fillStyle = '#19252b'; ctx.fillRect(0, 0, w, h);
    const size = Math.min(w, h), left = (w - size) / 2, top = (h - size) / 2;
    if (source.width > 0) ctx.drawImage(source, left, top, size, size);
    if (pose) {
      const [x, z] = worldToMinimap(pose.x, pose.z, size);
      ctx.save(); ctx.translate(left + Math.max(12, Math.min(size - 12, x)), top + Math.max(12, Math.min(size - 12, z))); ctx.rotate(-pose.yaw);
      ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(-6, -6); ctx.lineTo(6, -6); ctx.closePath();
      ctx.fillStyle = '#ffce78'; ctx.fill(); ctx.strokeStyle = '#19252b'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
    }
  };
  canvas.addEventListener('click', onSwap);
  const setWaterVisible = (b: boolean) => {
    water = b; toggle.textContent = b ? 'Water on' : 'Water off';
    toggle.setAttribute('aria-pressed', String(b)); onWaterChange?.(b);
  };
  toggle.addEventListener('click', (e) => { e.stopPropagation(); setWaterVisible(!water); });
  const observer = new ResizeObserver(draw);
  const setContainer = (el: HTMLElement) => { observer.disconnect(); el.append(root); observer.observe(root); draw(); };
  setContainer(container);
  return {
    setImage(rgba: Uint8Array, w: number, h: number) {
      source.width = w; source.height = h;
      source.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0); draw();
    },
    setCamera(p: CameraPose) { pose = p; draw(); },
    setWaterVisible,
    setContainer,
    dispose() { observer.disconnect(); root.remove(); },
  };
}

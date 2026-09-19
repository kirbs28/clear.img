// Masks are stored in the ALPHA channel of a canvas (RGB is always white).
// Erasing = destination-out, restoring = source-over, so soft brushes blend naturally.

export type BrushMode = 'erase' | 'restore';

export function grayToMaskCanvas(gray: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const img = new ImageData(width, height);
  const d = img.data;
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4;
    d[j] = d[j + 1] = d[j + 2] = 255;
    d[j + 3] = gray[i];
  }
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return canvas;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

// History snapshots keep only the alpha channel: 4x smaller than full RGBA.
export function snapshotAlpha(canvas: HTMLCanvasElement): Uint8Array {
  const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  const alpha = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return alpha;
}

export function applyAlpha(canvas: HTMLCanvasElement, alpha: Uint8Array) {
  const img = new ImageData(canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < alpha.length; i++) {
    const j = i * 4;
    d[j] = d[j + 1] = d[j + 2] = 255;
    d[j + 3] = alpha[i];
  }
  canvas.getContext('2d')!.putImageData(img, 0, 0);
}

/** One round soft dab. `hardness` 1 = crisp edge, 0 = fully feathered. */
export function stamp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  hardness: number,
  mode: BrushMode,
) {
  const g = ctx.createRadialGradient(x, y, radius * Math.min(hardness, 0.99), x, y, radius);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** Dabs evenly along a segment so fast pointer movement leaves no gaps. */
export function strokeSegment(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  hardness: number,
  mode: BrushMode,
) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(1, radius * 0.2);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    stamp(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius, hardness, mode);
  }
}

export type Background =
  | { type: 'transparent' }
  | { type: 'color'; color: string }
  | { type: 'blur'; amount: number }
  | { type: 'image'; image: ImageBitmap };

/**
 * Original RGB + merged alpha mask + optional background -> `ctx`.
 * `scratch` is a reusable w*h canvas so no canvas is allocated per frame.
 */
export function renderComposite(
  ctx: CanvasRenderingContext2D,
  original: ImageBitmap,
  mask: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
  bg: Background,
) {
  const { width: w, height: h } = ctx.canvas;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);

  drawBackground(ctx, original, bg, w, h);

  const s = scratch.getContext('2d')!;
  s.globalCompositeOperation = 'source-over';
  s.clearRect(0, 0, w, h);
  s.drawImage(original, 0, 0, w, h);
  s.globalCompositeOperation = 'destination-in'; // keep original pixels only where the mask is opaque
  s.drawImage(mask, 0, 0);

  ctx.drawImage(scratch, 0, 0);
}

function drawBackground(ctx: CanvasRenderingContext2D, original: ImageBitmap, bg: Background, w: number, h: number) {
  switch (bg.type) {
    case 'color':
      ctx.fillStyle = bg.color;
      ctx.fillRect(0, 0, w, h);
      break;
    case 'blur': {
      // Overscan so the blur doesn't fade to transparent at the borders.
      const m = bg.amount * 2;
      ctx.filter = `blur(${bg.amount}px)`;
      ctx.drawImage(original, -m, -m, w + m * 2, h + m * 2);
      ctx.filter = 'none';
      break;
    }
    case 'image': {
      // "cover" fit
      const k = Math.max(w / bg.image.width, h / bg.image.height);
      const dw = bg.image.width * k;
      const dh = bg.image.height * k;
      ctx.drawImage(bg.image, (w - dw) / 2, (h - dh) / 2, dw, dh);
      break;
    }
    case 'transparent':
      break;
  }
}

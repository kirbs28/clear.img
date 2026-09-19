// Images larger than this are downscaled before inference and editing. It keeps
// VRAM use bounded, and the model itself resamples to 1024px anyway.
export const MAX_SIDE = 2048;

export async function loadImage(blob: Blob): Promise<ImageBitmap> {
  // 'from-image' applies the EXIF orientation so phone photos aren't sideways.
  const full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(full.width, full.height));
  if (scale === 1) return full;

  const resized = await createImageBitmap(full, {
    resizeWidth: Math.round(full.width * scale),
    resizeHeight: Math.round(full.height * scale),
    resizeQuality: 'high',
  });
  full.close();
  return resized;
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/// <reference lib="webworker" />
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';

// Inference runs here so the UI thread never freezes. Weights are fetched once
// from the Hugging Face hub and then served from the browser's Cache API.
env.allowLocalModels = false;

const MODEL_ID = 'briaai/RMBG-1.4';

// RMBG-1.4 is a custom architecture, so the preprocessing config is supplied explicitly.
const PROCESSOR_CONFIG = {
  do_normalize: true,
  do_pad: false,
  do_rescale: true,
  do_resize: true,
  image_mean: [0.5, 0.5, 0.5],
  feature_extractor_type: 'ImageFeatureExtractor',
  image_std: [1, 1, 1],
  resample: 2,
  rescale_factor: 0.00392156862745098,
  size: { width: 1024, height: 1024 },
};

type Device = 'webgpu' | 'wasm';
interface Loaded {
  model: any;
  processor: any;
  device: Device;
}

const ctx = self as any;
let modelPromise: Promise<Loaded> | null = null;
let preferWebGPU = Boolean(ctx.navigator?.gpu);

// Report progress of the largest file (the .onnx weights) rather than an
// average, otherwise the tiny config files make the bar jump to 100% early.
const files = new Map<string, { loaded: number; total: number }>();
function onProgress(p: any) {
  if (p.status !== 'progress' || !p.total) return;
  files.set(p.file, { loaded: p.loaded, total: p.total });
  let biggest = { loaded: 0, total: 0 };
  files.forEach((f) => {
    if (f.total > biggest.total) biggest = f;
  });
  ctx.postMessage({ type: 'progress', progress: (biggest.loaded / biggest.total) * 100 });
}

async function loadModel(): Promise<Loaded> {
  const processor = await AutoProcessor.from_pretrained(MODEL_ID, { config: PROCESSOR_CONFIG as any });
  const base = { config: { model_type: 'custom' } as any, progress_callback: onProgress };

  if (preferWebGPU) {
    try {
      const model = await AutoModel.from_pretrained(MODEL_ID, { ...base, device: 'webgpu', dtype: 'fp32' });
      ctx.postMessage({ type: 'ready', device: 'webgpu' });
      return { model, processor, device: 'webgpu' };
    } catch (err) {
      console.warn('WebGPU unavailable, falling back to WASM', err);
      preferWebGPU = false;
    }
  }

  const model = await AutoModel.from_pretrained(MODEL_ID, { ...base, device: 'wasm', dtype: 'q8' });
  ctx.postMessage({ type: 'ready', device: 'wasm' });
  return { model, processor, device: 'wasm' };
}

function getModel(): Promise<Loaded> {
  if (!modelPromise) {
    modelPromise = loadModel().catch((err) => {
      modelPromise = null; // allow a retry after a failed download
      throw err;
    });
  }
  return modelPromise;
}

async function runInference(bitmap: ImageBitmap): Promise<{ width: number; height: number; mask: Uint8ClampedArray }> {
  const { model, processor } = await getModel();
  const { width, height } = bitmap;

  const canvas = new OffscreenCanvas(width, height);
  const c2d = canvas.getContext('2d')!;
  c2d.drawImage(bitmap, 0, 0);
  const { data } = c2d.getImageData(0, 0, width, height);
  const image = new RawImage(new Uint8ClampedArray(data), width, height, 4).rgb();

  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });

  // Model output is a 1024x1024 matte in [0,1]; scale back up to the input size.
  const matte = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(width, height);
  return { width, height, mask: new Uint8ClampedArray(matte.data) };
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await getModel();
    } else if (msg.type === 'segment') {
      let result;
      try {
        result = await runInference(msg.bitmap);
      } catch (err) {
        // Some GPUs load the model fine but fail on an op at run time: retry on WASM once.
        const loaded = await modelPromise?.catch(() => null);
        if (loaded?.device !== 'webgpu') throw err;
        console.warn('WebGPU inference failed, retrying on WASM', err);
        preferWebGPU = false;
        modelPromise = null;
        result = await runInference(msg.bitmap);
      }
      msg.bitmap.close();
      ctx.postMessage({ type: 'result', id: msg.id, ...result }, [result.mask.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};

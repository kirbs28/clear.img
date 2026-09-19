/// <reference lib="webworker" />
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';

// Inference runs here so the UI thread never freezes. Weights are fetched once
// from the Hugging Face hub and then served from the browser's Cache API.
env.allowLocalModels = false;

type Kind = 'general' | 'person';
type Device = 'webgpu' | 'wasm';

interface Net {
  model: any;
  processor: any;
  device: Device;
}

const SPECS: Record<Kind, { id: string; custom?: boolean; processorConfig?: object }> = {
  // General purpose: any subject. RMBG-1.4 is a custom architecture, so its
  // preprocessing config is supplied explicitly.
  general: {
    id: 'briaai/RMBG-1.4',
    custom: true,
    processorConfig: {
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
    },
  },
  // Portrait matting model trained specifically on people (Apache-2.0, ~26 MB).
  person: { id: 'Xenova/modnet' },
};

const ctx = self as any;
const nets: Partial<Record<Kind, Promise<Net>>> = {};
let preferWebGPU = Boolean(ctx.navigator?.gpu);

// Report progress of the largest file (the .onnx weights) rather than an
// average, otherwise the tiny config files make the bar jump to 100% early.
const files = new Map<string, { loaded: number; total: number }>();
function onProgress(kind: Kind, p: any) {
  if (p.status !== 'progress' || !p.total) return;
  files.set(p.file, { loaded: p.loaded, total: p.total });
  let biggest = { loaded: 0, total: 0 };
  files.forEach((f) => {
    if (f.total > biggest.total) biggest = f;
  });
  ctx.postMessage({ type: 'progress', model: kind, progress: (biggest.loaded / biggest.total) * 100 });
}

async function loadNet(kind: Kind): Promise<Net> {
  files.clear();
  const spec = SPECS[kind];
  const processor = await AutoProcessor.from_pretrained(
    spec.id,
    spec.processorConfig ? { config: spec.processorConfig as any } : {},
  );
  const opts = {
    ...(spec.custom ? { config: { model_type: 'custom' } as any } : {}),
    progress_callback: (p: any) => onProgress(kind, p),
  };

  if (preferWebGPU) {
    try {
      const model = await AutoModel.from_pretrained(spec.id, { ...opts, device: 'webgpu', dtype: 'fp32' });
      ctx.postMessage({ type: 'ready', model: kind, device: 'webgpu' });
      return { model, processor, device: 'webgpu' };
    } catch (err) {
      console.warn('WebGPU unavailable, falling back to WASM', err);
      preferWebGPU = false;
    }
  }

  const model = await AutoModel.from_pretrained(spec.id, { ...opts, device: 'wasm', dtype: 'q8' });
  ctx.postMessage({ type: 'ready', model: kind, device: 'wasm' });
  return { model, processor, device: 'wasm' };
}

function getNet(kind: Kind): Promise<Net> {
  let p = nets[kind];
  if (!p) {
    p = nets[kind] = loadNet(kind).catch((err) => {
      delete nets[kind]; // allow a retry after a failed download
      throw err;
    });
  }
  return p;
}

/** Run one model and return its 8-bit matte at the input's size. */
async function matte(kind: Kind, image: RawImage): Promise<Uint8ClampedArray> {
  const { model, processor } = await getNet(kind);
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });
  // Clamp before the uint8 cast: a value like 1.01 would otherwise wrap around to ~0.
  const out = await RawImage.fromTensor(output[0].clamp(0, 1).mul(255).to('uint8')).resize(image.width, image.height);
  return new Uint8ClampedArray(out.data);
}

async function runInference(
  bitmap: ImageBitmap,
  subject: 'auto' | 'person',
): Promise<{ width: number; height: number; mask: Uint8ClampedArray }> {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const c2d = canvas.getContext('2d')!;
  c2d.drawImage(bitmap, 0, 0);
  const { data } = c2d.getImageData(0, 0, width, height);
  const image = new RawImage(new Uint8ClampedArray(data), width, height, 4).rgb();

  const mask = await matte('general', image);
  if (subject === 'person') {
    // Keep only what BOTH models call foreground. The general model gives clean
    // hair/edge detail; the portrait model rejects background it wrongly kept.
    const person = await matte('person', image);
    for (let i = 0; i < mask.length; i++) mask[i] = Math.min(mask[i], person[i]);
  }
  return { width, height, mask };
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await getNet('general');
    } else if (msg.type === 'segment') {
      let result;
      try {
        result = await runInference(msg.bitmap, msg.subject);
      } catch (err) {
        // Some GPUs load a model fine but fail on an op at run time: retry once on WASM.
        if (!preferWebGPU) throw err;
        console.warn('WebGPU inference failed, retrying on WASM', err);
        preferWebGPU = false;
        delete nets.general;
        delete nets.person;
        result = await runInference(msg.bitmap, msg.subject);
      }
      msg.bitmap.close();
      ctx.postMessage({ type: 'result', id: msg.id, ...result }, [result.mask.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};

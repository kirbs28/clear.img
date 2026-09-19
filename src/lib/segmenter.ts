// Main-thread client for the inference worker. A module-level singleton, so the
// model is downloaded once even under React StrictMode's double mount.

export interface SegmenterState {
  model: 'idle' | 'loading' | 'ready' | 'error';
  progress: number; // 0-100, download progress of the model weights
  device: 'webgpu' | 'wasm' | null;
  running: boolean;
}

export interface SegmentResult {
  width: number;
  height: number;
  mask: Uint8ClampedArray; // 8-bit grayscale matte, 255 = keep
}

let state: SegmenterState = { model: 'idle', progress: 0, device: null, running: false };
const listeners = new Set<() => void>();
const pending = new Map<number, { resolve: (r: SegmentResult) => void; reject: (e: Error) => void }>();
let worker: Worker | null = null;
let nextId = 1;

function setState(patch: Partial<SegmenterState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/segment.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      setState({ model: 'loading', progress: msg.progress });
    } else if (msg.type === 'ready') {
      setState({ model: 'ready', progress: 100, device: msg.device });
    } else if (msg.type === 'result') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      setState({ running: pending.size > 0 });
      p?.resolve({ width: msg.width, height: msg.height, mask: msg.mask });
    } else if (msg.type === 'error') {
      const p = msg.id != null ? pending.get(msg.id) : undefined;
      if (msg.id != null) pending.delete(msg.id);
      setState({ model: state.model === 'ready' ? 'ready' : 'error', running: pending.size > 0 });
      p?.reject(new Error(msg.message));
    }
  };
  return worker;
}

export const segmenter = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => state,

  /** Start downloading/initialising the model before the user has picked an image. */
  preload() {
    if (state.model !== 'idle' && state.model !== 'error') return;
    setState({ model: 'loading', progress: 0 });
    getWorker().postMessage({ type: 'load' });
  },

  async segment(bitmap: ImageBitmap): Promise<SegmentResult> {
    const w = getWorker();
    if (state.model === 'idle' || state.model === 'error') setState({ model: 'loading', progress: 0 });
    const copy = await createImageBitmap(bitmap); // the copy is transferred; the caller keeps the original
    const id = nextId++;
    setState({ running: true });
    return new Promise<SegmentResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ type: 'segment', id, bitmap: copy }, [copy]);
    });
  },
};

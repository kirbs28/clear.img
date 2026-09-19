# clear.img

A free, private background remover. The AI model runs **entirely in the user's browser**
(WebGPU, with a WASM fallback), so there is no inference server, no per-image cost and
no photo ever leaves the device.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build into dist/
```

## How it works

```
drop / paste / browse
  -> loadImage()            EXIF-normalise, downscale to <= 2048px
  -> segmenter (main)  ---> segment.worker.ts (Web Worker)
                             Transformers.js + briaai/RMBG-1.4
                             WebGPU fp32, falls back to WASM q8
  <- 8-bit alpha matte
  -> Editor
       original canvas   (RGB, never modified)
       aiMask canvas     (model matte, never modified)
       working mask      (aiMask + erase/restore brush strokes, alpha channel)
       composite         original ∩ mask over transparent / colour / blur / image
  -> download PNG or WebP (32-bit, alpha preserved)
```

| File | Role |
| --- | --- |
| `src/workers/segment.worker.ts` | Model load + inference off the UI thread |
| `src/lib/segmenter.ts` | Main-thread client / singleton store for the worker |
| `src/lib/composite.ts` | Original + mask + background compositing |
| `src/lib/mask.ts` | Soft brush, alpha snapshots for undo/redo |
| `src/components/Editor.tsx` | Canvas editor: brush, zoom/pan, compare slider, export |

## Editor controls

| Action | Input |
| --- | --- |
| Erase / Restore / Pan tool | `E` / `R` / `H` |
| Brush size | `[` and `]`, or the slider |
| Zoom | mouse wheel (zooms at the cursor) |
| Pan | hold `Space`, middle-mouse drag, or the Pan tool |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Compare | toggle, then drag the divider |

## Notes

- First visit downloads the model (~176 MB for WebGPU fp32, ~44 MB quantized for WASM). The browser caches it afterwards.
  The download starts on page load, before an image is chosen.
- ONNX Runtime's `.wasm` files load from the jsDelivr CDN by default. To self-host them, copy them from
  `node_modules/onnxruntime-web/dist` and set `env.backends.onnx.wasm.wasmPaths` in the worker.
- Blur background uses `CanvasRenderingContext2D.filter`, which older Safari versions do not support.
- Undo history keeps the last 25 strokes as alpha-only snapshots.
- Deploy `dist/` to any static host (Cloudflare Pages, Vercel, Netlify).
- RMBG-1.4 is released by BRIA under a non-commercial licence. Check its terms before commercial use, or swap in
  a permissively licensed model (the model id is one constant in the worker).

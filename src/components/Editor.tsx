import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Brush,
  Columns2,
  Download,
  Eraser,
  Hand,
  ImagePlus,
  Plus,
  Redo2,
  RotateCcw,
  Undo2,
} from 'lucide-react';
import { type Background, renderComposite } from '../lib/composite';
import { download } from '../lib/image';
import { applyAlpha, cloneCanvas, snapshotAlpha, strokeSegment } from '../lib/mask';
import type { Subject } from '../lib/segmenter';
import SubjectPicker from './SubjectPicker';

type Tool = 'erase' | 'restore' | 'pan';
type BgKind = 'transparent' | 'color' | 'blur' | 'image';

interface Props {
  original: ImageBitmap;
  aiMask: HTMLCanvasElement;
  subject: Subject;
  onSubjectChange: (s: Subject) => void;
  onNewFile: (file: File) => void;
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const HISTORY_LIMIT = 25;
const SWATCHES = ['#ffffff', '#000000', '#f1f5f9', '#ef4444', '#3b82f6', '#22c55e'];

export default function Editor({ original, aiMask, subject, onSubjectChange, onNewFile }: Props) {
  const w = original.width;
  const h = original.height;

  // Layer stack: `original` (RGB, immutable) + `aiMask` (model matte, immutable)
  // + `mask` (working matte = aiMask plus every brush stroke).
  const [mask] = useState(() => cloneCanvas(aiMask));
  const [scratch] = useState(() => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  });

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<Uint8Array[]>([]);
  const redoRef = useRef<Uint8Array[]>([]);
  const spaceRef = useRef(false);
  const stroke = useRef<{ last: { x: number; y: number } } | null>(null);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const frame = useRef(0);

  const [tool, setTool] = useState<Tool>('erase');
  const [size, setSize] = useState(40);
  const [hardness, setHardness] = useState(0.7);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [historyCount, setHistoryCount] = useState({ undo: 0, redo: 0 });
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [bgKind, setBgKind] = useState<BgKind>('transparent');
  const [bgColor, setBgColor] = useState('#ffffff');
  const [blur, setBlur] = useState(16);
  const [bgImage, setBgImage] = useState<ImageBitmap | null>(null);
  const [format, setFormat] = useState<'png' | 'webp'>('png');

  const background = useMemo<Background>(() => {
    if (bgKind === 'color') return { type: 'color', color: bgColor };
    if (bgKind === 'blur') return { type: 'blur', amount: blur };
    if (bgKind === 'image' && bgImage) return { type: 'image', image: bgImage };
    return { type: 'transparent' };
  }, [bgKind, bgColor, blur, bgImage]);

  // ---------- rendering ----------
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    renderComposite(ctx, original, mask, scratch, background);
    if (compare) {
      // Left of the divider shows the untouched original.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, Math.round(w * split), h);
      ctx.clip();
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(original, 0, 0);
      ctx.restore();
    }
  }, [original, mask, scratch, background, compare, split, w, h]);

  const renderRef = useRef(render);
  renderRef.current = render;
  useEffect(() => render(), [render]);

  const scheduleRender = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      renderRef.current();
    });
  };

  // ---------- view: fit, zoom, pan ----------
  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const { width: cw, height: ch } = stage.getBoundingClientRect();
    const scale = Math.min((cw * 0.94) / w, (ch * 0.94) / h, 3);
    setView({ scale, x: (cw - w * scale) / 2, y: (ch - h * scale) / 2 });
  }, [w, h]);

  useEffect(() => {
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);

  // Wheel needs a non-passive listener to preventDefault (React's onWheel is passive).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const scale = Math.min(32, Math.max(0.05, v.scale * Math.exp(-e.deltaY * 0.0015)));
        const k = scale / v.scale;
        // keep the image point under the cursor fixed
        return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  // ---------- history ----------
  const syncHistory = () => setHistoryCount({ undo: undoRef.current.length, redo: redoRef.current.length });

  const pushUndo = () => {
    undoRef.current.push(snapshotAlpha(mask));
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
    redoRef.current = [];
    syncHistory();
  };

  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(snapshotAlpha(mask));
    applyAlpha(mask, prev);
    syncHistory();
    render();
  };

  const redo = () => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(snapshotAlpha(mask));
    applyAlpha(mask, next);
    syncHistory();
    render();
  };

  const resetToAi = () => {
    pushUndo();
    const ctx = mask.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(aiMask, 0, 0);
    render();
  };

  // A new AI matte arrives when the subject type changes: swap it in as an undoable step.
  const initialAi = useRef(aiMask);
  useEffect(() => {
    if (aiMask === initialAi.current) return;
    initialAi.current = aiMask;
    resetToAi();
  }, [aiMask]);

  // ---------- keyboard ----------
  const handlersRef = useRef({ undo, redo });
  handlersRef.current = { undo, redo };

  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'color') ;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handlersRef.current.redo();
        else handlersRef.current.undo();
      } else if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        handlersRef.current.redo();
      } else if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      } else if (key === ' ') {
        if (!(e.target instanceof HTMLButtonElement)) e.preventDefault();
        spaceRef.current = true;
        stageRef.current?.classList.add('panning');
      } else if (key === 'e') setTool('erase');
      else if (key === 'r') setTool('restore');
      else if (key === 'h') setTool('pan');
      else if (key === '[') setSize((s) => Math.max(4, s - 4));
      else if (key === ']') setSize((s) => Math.min(200, s + 4));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        spaceRef.current = false;
        stageRef.current?.classList.remove('panning');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // ---------- pointer: paint / pan ----------
  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * w) / r.width, y: ((e.clientY - r.top) * h) / r.height };
  };

  const moveRing = (e: React.PointerEvent) => {
    const ring = ringRef.current;
    const stage = stageRef.current;
    if (!ring || !stage) return;
    const r = stage.getBoundingClientRect();
    ring.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px) translate(-50%, -50%)`;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const stage = stageRef.current!;
    if (e.button === 1 || (e.button === 0 && (tool === 'pan' || spaceRef.current))) {
      e.preventDefault();
      stage.setPointerCapture(e.pointerId);
      pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      stage.classList.add('dragging');
    } else if (e.button === 0) {
      stage.setPointerCapture(e.pointerId);
      pushUndo();
      const p = toImage(e);
      stroke.current = { last: p };
      const mode = tool === 'erase' ? 'erase' : 'restore';
      strokeSegment(mask.getContext('2d')!, p, p, size / 2, hardness, mode);
      scheduleRender();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    moveRing(e);
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, x: p.vx + e.clientX - p.sx, y: p.vy + e.clientY - p.sy }));
    } else if (stroke.current) {
      const p = toImage(e);
      strokeSegment(mask.getContext('2d')!, stroke.current.last, p, size / 2, hardness, tool === 'erase' ? 'erase' : 'restore');
      stroke.current.last = p;
      scheduleRender();
    }
  };

  const onPointerUp = () => {
    pan.current = null;
    stroke.current = null;
    stageRef.current?.classList.remove('dragging');
  };

  // ---------- compare divider drag ----------
  const onDividerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDividerMove = (e: React.PointerEvent) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.stopPropagation();
    const x = toImage(e).x / w;
    setSplit(Math.min(1, Math.max(0, x)));
  };

  // ---------- background image / export ----------
  const pickBgImage = async (file: File) => {
    setBgImage(await createImageBitmap(file, { imageOrientation: 'from-image' }));
    setBgKind('image');
  };

  const exportImage = () => {
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    renderComposite(out.getContext('2d')!, original, mask, scratch, background);
    const type = format === 'png' ? 'image/png' : 'image/webp';
    out.toBlob((blob) => blob && download(blob, `clear-img-cutout.${format}`), type, 0.95);
  };

  const ringSize = size * view.scale;
  const paintTool = tool !== 'pan';

  return (
    <div className="editor">
      <aside className="panel">
        <section>
          <h3>Subject</h3>
          <SubjectPicker value={subject} onChange={onSubjectChange} />
          <p className="hint">Background left behind a person? Choose Person to re-run with a portrait model.</p>
        </section>

        <section>
          <h3>Tools</h3>
          <div className="btn-row">
            <ToolButton active={tool === 'erase'} onClick={() => setTool('erase')} label="Erase (E)">
              <Eraser size={16} /> Erase
            </ToolButton>
            <ToolButton active={tool === 'restore'} onClick={() => setTool('restore')} label="Restore (R)">
              <Brush size={16} /> Restore
            </ToolButton>
            <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')} label="Pan (H or hold Space)">
              <Hand size={16} /> Pan
            </ToolButton>
          </div>

          <label className="slider">
            <span>
              Brush size <b>{size}px</b>
            </span>
            <input type="range" min={4} max={200} value={size} onChange={(e) => setSize(+e.target.value)} />
          </label>
          <label className="slider">
            <span>
              Hardness <b>{Math.round(hardness * 100)}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(hardness * 100)}
              onChange={(e) => setHardness(+e.target.value / 100)}
            />
          </label>

          <div className="btn-row">
            <button className="btn" onClick={undo} disabled={!historyCount.undo} title="Undo (Ctrl+Z)">
              <Undo2 size={16} /> Undo
            </button>
            <button className="btn" onClick={redo} disabled={!historyCount.redo} title="Redo (Ctrl+Shift+Z)">
              <Redo2 size={16} /> Redo
            </button>
          </div>
          <button className="btn wide" onClick={resetToAi} title="Discard all brush edits">
            <RotateCcw size={16} /> Reset to AI result
          </button>
        </section>

        <section>
          <h3>Background</h3>
          <div className="swatches">
            <button
              className={`swatch checker ${bgKind === 'transparent' ? 'on' : ''}`}
              title="Transparent"
              onClick={() => setBgKind('transparent')}
            />
            {SWATCHES.map((c) => (
              <button
                key={c}
                className={`swatch ${bgKind === 'color' && bgColor === c ? 'on' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={() => {
                  setBgColor(c);
                  setBgKind('color');
                }}
              />
            ))}
            <label className={`swatch custom ${bgKind === 'color' && !SWATCHES.includes(bgColor) ? 'on' : ''}`} title="Custom colour">
              <input
                type="color"
                value={bgColor}
                onChange={(e) => {
                  setBgColor(e.target.value);
                  setBgKind('color');
                }}
              />
            </label>
          </div>

          <div className="btn-row">
            <button className={`btn ${bgKind === 'blur' ? 'active' : ''}`} onClick={() => setBgKind('blur')}>
              Blur original
            </button>
            <label className={`btn ${bgKind === 'image' ? 'active' : ''}`}>
              <ImagePlus size={16} /> Image
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickBgImage(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {bgKind === 'blur' && (
            <label className="slider">
              <span>
                Blur <b>{blur}px</b>
              </span>
              <input type="range" min={2} max={60} value={blur} onChange={(e) => setBlur(+e.target.value)} />
            </label>
          )}
        </section>

        <section>
          <h3>View</h3>
          <div className="btn-row">
            <button className={`btn ${compare ? 'active' : ''}`} onClick={() => setCompare((c) => !c)}>
              <Columns2 size={16} /> Compare
            </button>
            <button className="btn" onClick={fit}>
              Fit
            </button>
          </div>
          <p className="hint">Scroll to zoom · hold Space or middle-mouse to pan · [ ] resize brush</p>
        </section>

        <section className="grow" />

        <section>
          <div className="btn-row">
            <select value={format} onChange={(e) => setFormat(e.target.value as 'png' | 'webp')} className="select">
              <option value="png">PNG</option>
              <option value="webp">WebP</option>
            </select>
            <button className="btn primary grow-btn" onClick={exportImage}>
              <Download size={16} /> Download
            </button>
          </div>
          <label className="btn wide">
            <Plus size={16} /> New image
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onNewFile(f);
                e.target.value = '';
              }}
            />
          </label>
        </section>
      </aside>

      <div
        ref={stageRef}
        className={`stage ${paintTool ? 'paint' : 'pan-tool'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={(e) => {
          moveRing(e);
          ringRef.current?.classList.add('visible');
        }}
        onPointerLeave={() => ringRef.current?.classList.remove('visible')}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas
          ref={canvasRef}
          width={w}
          height={h}
          className={`canvas ${bgKind === 'transparent' && !compare ? 'checker' : ''}`}
          style={{
            width: w,
            height: h,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            imageRendering: view.scale > 3 ? 'pixelated' : 'auto',
          }}
        />

        {compare && (
          <div
            className="divider"
            style={{ left: view.x + w * split * view.scale, top: view.y, height: h * view.scale }}
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
          >
            <span className="divider-knob">
              <Columns2 size={14} />
            </span>
            <span className="divider-tag left">Original</span>
            <span className="divider-tag right">Cutout</span>
          </div>
        )}

        {paintTool && (
          <div
            ref={ringRef}
            className={`ring ${tool}`}
            style={{ width: ringSize, height: ringSize }}
          />
        )}
      </div>
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button className={`btn ${active ? 'active' : ''}`} onClick={onClick} title={label}>
      {children}
    </button>
  );
}

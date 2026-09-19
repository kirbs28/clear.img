import { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, Loader2 } from 'lucide-react';
import logo from './assets/logo.png';
import Dropzone from './components/Dropzone';
import Editor from './components/Editor';
import { useSegmenter } from './hooks/useSegmenter';
import { loadImage } from './lib/image';
import { grayToMaskCanvas } from './lib/mask';
import { segmenter, type Subject } from './lib/segmenter';

interface Session {
  id: number;
  original: ImageBitmap;
  aiMask: HTMLCanvasElement;
}

export default function App() {
  const seg = useSegmenter();
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [subject, setSubject] = useState<Subject>('auto');
  const subjectRef = useRef<Subject>('auto'); // read by the window-level paste/drop handlers
  const counter = useRef(0);

  // Start fetching the model immediately so it's usually ready by the time an image is dropped.
  useEffect(() => segmenter.preload(), []);

  const handleFile = useCallback(async (file: Blob) => {
    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const original = await loadImage(file);
      const result = await segmenter.segment(original, subjectRef.current);
      setSession({
        id: ++counter.current,
        original,
        aiMask: grayToMaskCanvas(result.mask, result.width, result.height),
      });
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Something went wrong processing that image.');
    } finally {
      setBusy(false);
    }
  }, []);

  // Re-run the current image with a different subject hint (e.g. background left behind a person).
  const changeSubject = useCallback(
    async (next: Subject) => {
      const previous = subjectRef.current;
      subjectRef.current = next;
      setSubject(next);
      if (!session) return;
      setError(null);
      setBusy(true);
      try {
        const result = await segmenter.segment(session.original, next);
        const aiMask = grayToMaskCanvas(result.mask, result.width, result.height);
        setSession((s) => (s ? { ...s, aiMask } : s));
      } catch (err) {
        console.error(err);
        subjectRef.current = previous;
        setSubject(previous);
        setError(err instanceof Error ? err.message : 'Could not re-run with that subject type.');
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  // Window-level paste and drag & drop, active on both the landing page and in the editor.
  useEffect(() => {
    let depth = 0;
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (file) handleFile(file);
    };
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDragging(true);
    };
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) handleFile(file);
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFile]);

  const downloadingPerson = busy && subject === 'person' && seg.personModel === 'loading' && seg.personProgress < 100;
  const downloadingGeneral = seg.model === 'loading' && seg.progress < 100;
  const downloading = downloadingPerson || downloadingGeneral;
  const downloadProgress = downloadingPerson ? seg.personProgress : seg.progress;

  return (
    <div className="app">
      <header className="topbar">
        <img className="brand-logo" src={logo} alt="clear.img" />
        <div className="model-badge" title="The model runs on your device. Images are never uploaded.">
          <Cpu size={13} />
          {seg.model === 'ready' && <span>Model ready · {seg.device === 'webgpu' ? 'WebGPU' : 'WASM'}</span>}
          {seg.model === 'loading' && <span>Loading model{seg.progress > 0 ? ` ${Math.round(seg.progress)}%` : '…'}</span>}
          {seg.model === 'error' && <span>Model failed to load</span>}
          {seg.model === 'idle' && <span>Model idle</span>}
        </div>
      </header>

      <main className="main">
        {session ? (
          <Editor
            key={session.id}
            original={session.original}
            aiMask={session.aiMask}
            subject={subject}
            onSubjectChange={changeSubject}
            onNewFile={handleFile}
          />
        ) : (
          <Dropzone onFile={handleFile} subject={subject} onSubjectChange={changeSubject} />
        )}
      </main>

      {error && (
        <div className="toast" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {dragging && <div className="drop-overlay">Drop an image to remove its background</div>}

      {busy && (
        <div className="busy-overlay">
          <Loader2 className="spin" size={28} />
          <div className="busy-title">{downloading ? `Downloading the ${downloadingPerson ? 'person' : 'AI'} model…` : 'Removing background…'}</div>
          {downloading ? (
            <>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${downloadProgress}%` }} />
              </div>
              <div className="busy-sub">One-time download, cached in your browser afterwards.</div>
            </>
          ) : (
            <div className="busy-sub">Running on your device. Nothing is uploaded.</div>
          )}
        </div>
      )}
    </div>
  );
}

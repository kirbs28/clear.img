import { useRef } from 'react';
import { Lock, Upload, Wand2, Zap } from 'lucide-react';

export default function Dropzone({ onFile }: { onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="landing">
      <h1>Remove image backgrounds, free.</h1>
      <p className="lead">
        Runs entirely in your browser with an open-source AI model. No uploads, no sign-up, no limits.
      </p>

      <button className="dropzone" onClick={() => input.current?.click()}>
        <Upload size={30} />
        <span className="dz-title">Drop an image, click to browse, or paste with Ctrl+V</span>
        <span className="dz-sub">PNG, JPG or WebP</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />

      <ul className="features">
        <li>
          <Lock size={16} /> Private: photos never leave your device
        </li>
        <li>
          <Zap size={16} /> Fast: GPU accelerated with WebGPU
        </li>
        <li>
          <Wand2 size={16} /> Erase / restore brush for touch-ups
        </li>
      </ul>
    </div>
  );
}

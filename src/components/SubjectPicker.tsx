import { Sparkles, User } from 'lucide-react';
import type { Subject } from '../lib/segmenter';

const OPTIONS: { value: Subject; label: string; title: string; icon: React.ReactNode }[] = [
  { value: 'auto', label: 'Auto', title: 'General purpose: objects, products, animals, people', icon: <Sparkles size={15} /> },
  {
    value: 'person',
    label: 'Person',
    title: 'Portrait mode: uses a model trained on people to remove leftover background',
    icon: <User size={15} />,
  },
];

export default function SubjectPicker({ value, onChange }: { value: Subject; onChange: (s: Subject) => void }) {
  return (
    <div className="btn-row" role="radiogroup" aria-label="Subject type">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={`btn ${value === o.value ? 'active' : ''}`}
          title={o.title}
          onClick={() => value !== o.value && onChange(o.value)}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  );
}

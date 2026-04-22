import { useEffect, useMemo, useState } from 'react';
import { AtomicCodeMirrorEditor } from '@atomic-editor/editor';
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages';
import '@atomic-editor/editor/styles.css';
import {
  SAMPLE_SIZES,
  generateSampleMarkdown,
  type SampleSize,
} from './sample-content';

type ThemeMode = 'dark' | 'light';

function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(2)} MB`;
}

export function App() {
  const [sampleSize, setSampleSize] = useState<SampleSize>('10 pages');
  const [theme, setTheme] = useState<ThemeMode>('dark');

  const markdownSource = useMemo(
    () => generateSampleMarkdown(sampleSize),
    [sampleSize],
  );

  // Remount when the document changes so cursor/undo state from the
  // previous sample doesn't leak into the next.
  const documentId = sampleSize;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="demo-root" data-theme={theme}>
      <header className="demo-header">
        <div className="demo-identity">
          <h1 className="demo-title">@atomic-editor/editor</h1>
          <p className="demo-sub">
            CodeMirror 6 markdown editor with Obsidian-style inline live preview.
          </p>
        </div>

        <div className="demo-control">
          <span className="demo-control-label">Theme</span>
          <SegmentedControl
            value={theme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
            onChange={setTheme}
          />
        </div>

        <div className="demo-control">
          <span className="demo-control-label">Sample</span>
          <SegmentedControl
            value={sampleSize}
            options={SAMPLE_SIZES.map((s) => ({ value: s, label: s }))}
            onChange={setSampleSize}
          />
          <span className="demo-meta">{formatBytes(markdownSource.length)}</span>
        </div>

        <a
          className="demo-github"
          href="https://github.com/kenforthewin/atomic-editor"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub →
        </a>
      </header>

      <main className="demo-canvas">
        <AtomicCodeMirrorEditor
          markdownSource={markdownSource}
          documentId={documentId}
          codeLanguages={ATOMIC_CODE_LANGUAGES}
          onLinkClick={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
        />
      </main>
    </div>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="demo-segmented">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

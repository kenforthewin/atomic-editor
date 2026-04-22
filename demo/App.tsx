import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from '@atomic-editor/editor';
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages';
import '@atomic-editor/editor/styles.css';
import {
  CODE_BLOCKS_MODES,
  LISTS_MODES,
  SAMPLE_MODES,
  SAMPLE_SIZES,
  SEPARATORS_MODES,
  TABLES_MODES,
  generateSampleMarkdown,
  type CodeBlocksMode,
  type ListsMode,
  type SampleMode,
  type SampleSize,
  type SeparatorsMode,
  type TablesMode,
} from './sample-content';
import { MinimalCodeMirrorEditor } from './MinimalEditor';
import { NoPreviewCodeMirrorEditor } from './NoPreviewEditor';
import { ScrollDiagnostics } from './ScrollDiagnostics';

type EditorFlavor = 'atomic' | 'no-preview' | 'minimal';
const EDITOR_FLAVORS: EditorFlavor[] = ['atomic', 'no-preview', 'minimal'];
type ThemeMode = 'dark' | 'light';

function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(2)} MB`;
}

export function App() {
  const [flavor, setFlavor] = useState<EditorFlavor>('atomic');
  const [sampleMode, setSampleMode] = useState<SampleMode>('with images');
  const [sampleSize, setSampleSize] = useState<SampleSize>('10 pages');
  const [codeBlocksMode, setCodeBlocksMode] = useState<CodeBlocksMode>('with code blocks');
  const [listsMode, setListsMode] = useState<ListsMode>('with lists');
  const [separatorsMode, setSeparatorsMode] = useState<SeparatorsMode>('with separators');
  const [tablesMode, setTablesMode] = useState<TablesMode>('with tables');
  const [codeLangsOn, setCodeLangsOn] = useState(true);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);

  const markdownSource = useMemo(
    () =>
      generateSampleMarkdown(sampleSize, {
        mode: sampleMode,
        codeBlocks: codeBlocksMode,
        lists: listsMode,
        separators: separatorsMode,
        tables: tablesMode,
      }),
    [sampleMode, sampleSize, codeBlocksMode, listsMode, separatorsMode, tablesMode],
  );

  // Identity for remount — any toggle that changes the document forces
  // a fresh editor so cursor/undo state from the previous sample
  // doesn't leak into the next.
  const documentId = useMemo(
    () =>
      [
        flavor,
        sampleMode,
        sampleSize,
        codeBlocksMode,
        listsMode,
        separatorsMode,
        tablesMode,
        codeLangsOn ? 'langs' : 'nolangs',
      ].join(':'),
    [
      flavor,
      sampleMode,
      sampleSize,
      codeBlocksMode,
      listsMode,
      separatorsMode,
      tablesMode,
      codeLangsOn,
    ],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="demo-root" data-theme={theme}>
      <aside className="demo-controls">
        <h1 className="demo-title">@atomic-editor/editor</h1>
        <p className="demo-sub">
          CodeMirror 6 markdown editor with Obsidian-style inline live preview.
        </p>
        <a
          className="demo-github"
          href="https://github.com/kenforthewin/editor"
          target="_blank"
          rel="noopener noreferrer"
        >
          View on GitHub →
        </a>

        <Section label="Theme">
          <SegmentedControl
            value={theme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
            onChange={setTheme}
          />
        </Section>

        <Section label="Editor flavor">
          <SegmentedControl
            value={flavor}
            options={EDITOR_FLAVORS.map((f) => ({ value: f, label: f }))}
            onChange={setFlavor}
          />
          <p className="demo-hint">
            <code>atomic</code> is the full library. <code>no-preview</code>{' '}
            disables inline preview; <code>minimal</code> is bare CM6 with
            lang-markdown — both are used to isolate perf regressions.
          </p>
        </Section>

        <Section label="Sample size">
          <SegmentedControl
            value={sampleSize}
            options={SAMPLE_SIZES.map((s) => ({ value: s, label: s }))}
            onChange={setSampleSize}
          />
          <p className="demo-hint">Document is {formatBytes(markdownSource.length)}.</p>
        </Section>

        <Section label="Images">
          <SegmentedControl
            value={sampleMode}
            options={SAMPLE_MODES.map((m) => ({ value: m, label: m }))}
            onChange={setSampleMode}
          />
        </Section>

        <Section label="Blocks">
          <SegmentedControl
            value={codeBlocksMode}
            options={CODE_BLOCKS_MODES.map((m) => ({ value: m, label: m }))}
            onChange={setCodeBlocksMode}
          />
          <SegmentedControl
            value={listsMode}
            options={LISTS_MODES.map((m) => ({ value: m, label: m }))}
            onChange={setListsMode}
          />
          <SegmentedControl
            value={tablesMode}
            options={TABLES_MODES.map((m) => ({ value: m, label: m }))}
            onChange={setTablesMode}
          />
          <SegmentedControl
            value={separatorsMode}
            options={SEPARATORS_MODES.map((m) => ({ value: m, label: m }))}
            onChange={setSeparatorsMode}
          />
        </Section>

        <Section label="Code-language highlighting">
          <label className="demo-checkbox">
            <input
              type="checkbox"
              checked={codeLangsOn}
              onChange={(e) => setCodeLangsOn(e.target.checked)}
            />
            <span>
              Load curated grammars (~20 languages, lazy-loaded per fence)
            </span>
          </label>
        </Section>

        <Section label="Diagnostics">
          <label className="demo-checkbox">
            <input
              type="checkbox"
              checked={showDiagnostics}
              onChange={(e) => setShowDiagnostics(e.target.checked)}
            />
            <span>Show scroll diagnostics overlay</span>
          </label>
          <p className="demo-hint">
            Detects momentum scroll halts (useful on iOS). Only active while
            visible.
          </p>
        </Section>
      </aside>

      <main className="demo-canvas">
        {flavor === 'atomic' && (
          <AtomicCodeMirrorEditor
            markdownSource={markdownSource}
            documentId={documentId}
            editorHandleRef={editorHandleRef}
            codeLanguages={codeLangsOn ? ATOMIC_CODE_LANGUAGES : undefined}
            onLinkClick={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
          />
        )}
        {flavor === 'no-preview' && (
          <NoPreviewCodeMirrorEditor
            markdownSource={markdownSource}
            documentId={documentId}
          />
        )}
        {flavor === 'minimal' && (
          <MinimalCodeMirrorEditor
            markdownSource={markdownSource}
            documentId={documentId}
          />
        )}
        {showDiagnostics && <ScrollDiagnostics />}
      </main>
    </div>
  );
}

// ---- small UI bits ----

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="demo-section">
      <div className="demo-section-label">{label}</div>
      {children}
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

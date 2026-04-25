import { useEffect, useMemo, useState } from 'react';
import {
  AtomicCodeMirrorEditor,
  wikiLinks,
  type WikiLinkSuggestion,
} from '@atomic-editor/editor';
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages';
import '@atomic-editor/editor/styles.css';
import {
  SAMPLE_SIZES,
  generateSampleMarkdown,
  type SampleSize,
} from './sample-content';

type ThemeMode = 'dark' | 'light';

const WIKI_TARGETS: WikiLinkSuggestion[] = [
  {
    target: 'demo-project-atlas',
    label: 'Project Atlas',
    detail: 'Project',
  },
  {
    target: 'demo-meeting-notes',
    label: 'Meeting Notes',
    detail: 'Recent',
  },
  {
    target: 'demo-editor-roadmap',
    label: 'Editor Roadmap',
    detail: 'Planning',
  },
  {
    target: 'demo-search-fallback',
    label: 'Search Fallback',
    detail: 'Content',
  },
];

const WIKI_SNIPPETS: Record<string, string> = {
  'demo-project-atlas': 'A project planning page used for labeled wiki-link rendering.',
  'demo-meeting-notes': 'Recent notes with a bare wiki-link target that resolves asynchronously.',
  'demo-editor-roadmap': 'A roadmap page for live preview, autocomplete, and deeplink behavior.',
  'demo-search-fallback': 'Fallback result for testing content-like matching in the demo.',
};

const WIKI_LINK_SAMPLE = `# Wiki Link Demo

Labeled link: [[demo-project-atlas|Project Atlas]]
Bare link: [[demo-meeting-notes]]
Try typing a new link with [[pro and use the completion menu.
Inline code stays raw: \`[[demo-project-atlas|Project Atlas]]\`
`;

function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(2)} MB`;
}

function findWikiTarget(target: string): WikiLinkSuggestion | undefined {
  return WIKI_TARGETS.find((candidate) => candidate.target === target);
}

function suggestWikiTargets(query: string): Promise<WikiLinkSuggestion[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return Promise.resolve(WIKI_TARGETS);

  return Promise.resolve(
    WIKI_TARGETS.filter((target) => {
      const snippet = WIKI_SNIPPETS[target.target] ?? '';
      return (
        target.label.toLowerCase().includes(normalized) ||
        target.target.toLowerCase().includes(normalized) ||
        snippet.toLowerCase().includes(normalized)
      );
    }),
  );
}

function readLinkedTargetFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('linkedTarget');
}

export function App() {
  const [sampleSize, setSampleSize] = useState<SampleSize>('10 pages');
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [openedWikiTarget, setOpenedWikiTarget] = useState<string | null>(() =>
    readLinkedTargetFromUrl(),
  );

  // Probe hook — `?reveal=…` in the demo URL triggers the editor's
  // `initialRevealText` path, so Playwright can drive the reveal
  // behavior without needing a separate control surface.
  const revealText = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('reveal');
  }, []);

  const markdownSource = useMemo(
    () => `${WIKI_LINK_SAMPLE}\n${generateSampleMarkdown(sampleSize)}`,
    [sampleSize],
  );

  // Remount when the document changes so cursor/undo state from the
  // previous sample doesn't leak into the next.
  const documentId = sampleSize;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const handlePopState = () => setOpenedWikiTarget(readLinkedTargetFromUrl());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const wikiLinkExtensions = useMemo(
    () => [
      wikiLinks({
        suggest: suggestWikiTargets,
        resolve: async (target) => {
          const linked = findWikiTarget(target);
          if (!linked) return null;
          return { target, label: linked.label, status: 'resolved' };
        },
        onOpen: (target) => {
          const url = new URL(window.location.href);
          url.searchParams.set('linkedTarget', target);
          window.history.pushState(null, '', url);
          setOpenedWikiTarget(target);
        },
        openOnClick: true,
      }),
    ],
    [],
  );

  const openedWikiLabel = openedWikiTarget
    ? findWikiTarget(openedWikiTarget)?.label ?? openedWikiTarget
    : null;

  return (
    <div className="demo-root" data-theme={theme}>
      <header className="demo-header">
        <div className="demo-identity">
          <h1 className="demo-title">Atomic Editor</h1>
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

        <div className="demo-deeplink" title="Cmd/Ctrl-click a rendered wiki link in the editor">
          <span className="demo-control-label">Deeplink</span>
          <span className="demo-deeplink-value">
            {openedWikiTarget ? `${openedWikiLabel} (${openedWikiTarget})` : 'none opened'}
          </span>
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
          initialRevealText={revealText}
          onLinkClick={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
          extensions={wikiLinkExtensions}
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

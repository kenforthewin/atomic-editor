import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
  wikiLinks,
} from '@atomic-editor/editor';
import '@atomic-editor/editor/styles.css';
import './harness.css';

type HarnessTheme = 'dark' | 'light';

interface HarnessOptions {
  readOnly?: boolean;
  theme?: HarnessTheme;
  wikiLinks?: boolean;
}

// Deterministic resolution: the target becomes its own label, so a spec
// can predict the rendered chip text exactly.
const WIKI_LINK_EXTENSIONS = [
  wikiLinks({
    resolve: async (target) => ({ target, label: target, status: 'resolved' }),
  }),
];

interface HarnessController {
  load(markdown: string, options?: HarnessOptions): Promise<void>;
  focus(): void;
  getMarkdown(): string;
  getOpenedUrls(): string[];
}

declare global {
  interface Window {
    atomicHarness?: HarnessController;
  }
}

interface HarnessState {
  markdown: string;
  readOnly: boolean;
  revision: number;
  theme: HarnessTheme;
  wikiLinks: boolean;
}

function Harness() {
  const handleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const openedUrls = useRef<string[]>([]);
  const pendingLoad = useRef<(() => void) | null>(null);
  const [state, setState] = useState<HarnessState>({
    markdown: '# harness ready',
    readOnly: false,
    revision: 0,
    theme: 'dark',
    wikiLinks: false,
  });

  useLayoutEffect(() => {
    window.atomicHarness = {
      load(markdown, options = {}) {
        openedUrls.current = [];
        return new Promise<void>((resolve) => {
          pendingLoad.current = resolve;
          setState((current) => ({
            markdown,
            readOnly: options.readOnly ?? false,
            revision: current.revision + 1,
            theme: options.theme ?? 'dark',
            wikiLinks: options.wikiLinks ?? false,
          }));
        });
      },
      focus() {
        handleRef.current?.focus();
      },
      getMarkdown() {
        return handleRef.current?.getMarkdown() ?? '';
      },
      getOpenedUrls() {
        return [...openedUrls.current];
      },
    };

    return () => {
      delete window.atomicHarness;
    };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    const resolve = pendingLoad.current;
    if (!resolve) return;
    pendingLoad.current = null;
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }, [state]);

  return (
    <main className="harness-shell" data-harness-revision={state.revision}>
      <div className="harness-editor">
        <AtomicCodeMirrorEditor
          documentId={`fixture-${state.revision}`}
          editorHandleRef={handleRef}
          extensions={state.wikiLinks ? WIKI_LINK_EXTENSIONS : undefined}
          markdownSource={state.markdown}
          onLinkClick={(url) => openedUrls.current.push(url)}
          readOnly={state.readOnly}
        />
      </div>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(<Harness />);

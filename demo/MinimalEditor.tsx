import { useEffect, useRef } from 'react';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

// Diagnostic-only editor used by the harness to isolate whether the
// iOS momentum-halt issue lives in our `@atomic-editor/editor` extensions
// or in CM6 core / lang-markdown. It mounts a CM6 view with the
// bare minimum — no inline preview, no custom widgets, no theme —
// so if momentum scroll is smooth here while still jittery in the
// main editor, the culprit is something we're adding. If halts
// still reproduce here, it's CM6 or lang-markdown itself, and no
// amount of extension tuning will help.

interface MinimalCodeMirrorEditorProps {
  markdownSource: string;
  documentId: string;
}

export function MinimalCodeMirrorEditor({
  markdownSource,
  documentId,
}: MinimalCodeMirrorEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const view = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: markdownSource,
        extensions: [
          // Absolute minimum to render wrapped markdown text with a
          // cursor and undo. Deliberately no widgets, no
          // decorations, no search, and nothing from
          // `@atomic-editor/editor`. If this scrolls smoothly on iOS, every
          // additional extension we layer on in
          // `AtomicCodeMirrorEditor` becomes a suspect.
          lineNumbers(),
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          // Height plumbing only — without this, the editor grows to
          // content height and the page doesn't scroll. The rule
          // matches what CM6 docs call out as the standard setup for
          // a fixed-height editor with an internal scroller. No
          // colors, fonts, or other visual overrides — still the
          // bare "CM6 core + lang-markdown" test case.
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
          }),
        ],
      }),
    });

    return () => {
      view.destroy();
    };
  }, [documentId, markdownSource]);

  return (
    <div
      ref={rootRef}
      className="atomic-cm-editor relative h-full w-full"
    />
  );
}

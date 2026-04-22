import { useEffect, useRef } from 'react';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { search, searchKeymap } from '@codemirror/search';
import {
  atomicEditorTheme,
  atomicMarkdownSyntax,
  extendEmphasisPair,
  imageBlocks,
  tables,
} from '@atomic-editor/editor';
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages';

// Diagnostic-only: mirrors AtomicCodeMirrorEditor's setup exactly
// EXCEPT that it omits `inlinePreview()`. Used by the harness to
// test whether the iOS momentum-halt issue lives specifically in
// the inline-preview decoration engine. If this flavor scrolls
// cleanly while `atomic` halts, the culprit is inline-preview's
// viewport-driven decoration rebuild or its associated ViewPlugins.
// If this flavor still halts, the halt lives in one of the other
// pieces (theme, tables, image-blocks, bracket pairing, search).
//
// The visible tradeoff in this flavor: no header / list / task
// rendering, no hidden syntax tokens — markdown appears as raw
// text. Fine for scroll diagnostics; not for normal use.

interface NoPreviewCodeMirrorEditorProps {
  markdownSource: string;
  documentId: string;
}

export function NoPreviewCodeMirrorEditor({
  markdownSource,
  documentId,
}: NoPreviewCodeMirrorEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const view = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: markdownSource,
        extensions: [
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          rectangularSelection(),
          highlightActiveLine(),
          closeBrackets(),
          extendEmphasisPair,
          EditorView.lineWrapping,
          search({ top: true }),
          markdown({
            base: markdownLanguage,
            codeLanguages: ATOMIC_CODE_LANGUAGES,
          }),
          markdownLanguage.data.of({
            closeBrackets: { brackets: ['(', '[', '{', "'", '"', '*', '_', '`'] },
          }),
          atomicMarkdownSyntax,
          atomicEditorTheme,
          keymap.of([
            ...closeBracketsKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...markdownKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          tables(),
          imageBlocks(),
          // inlinePreview() intentionally omitted — that's the
          // variable we're isolating.
        ],
      }),
    });

    return () => {
      view.destroy();
    };
  }, [documentId, markdownSource]);

  return <div ref={rootRef} className="atomic-cm-editor relative h-full w-full" />;
}

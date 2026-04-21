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
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';

import { ATOMIC_CODE_LANGUAGES } from './code-languages';
import { atomicEditorTheme, atomicMarkdownSyntax } from './atomic-theme';
import { inlinePreview } from './inline-preview';

export interface AtomicCodeMirrorEditorProps {
  /**
   * Opaque identity for the document. Swapping `documentId` tears down
   * and re-mounts the view so cursor / undo state from a previous
   * document doesn't leak. If omitted, the initial `markdownSource`
   * value is used as the identity — which means mounting a different
   * string produces a fresh editor.
   */
  documentId?: string;

  /**
   * The markdown document to open the editor on. Used only at mount
   * time — the editor is the source of truth for the doc after that.
   * To swap documents, change `documentId`.
   */
  markdownSource: string;

  /**
   * Called on every doc change with the current markdown. Fires for
   * both user edits and any dispatches the editor produces internally
   * (e.g. checkbox toggles, tight-list continuations).
   */
  onMarkdownChange?: (markdown: string) => void;

  /**
   * Called when the user plain-clicks a rendered link in the
   * inline-preview output. Receives the link's URL as written in the
   * source markdown. Defaults to `window.open(url, '_blank',
   * 'noopener,noreferrer')`. Provide your own handler to route opens
   * through a platform shell (Tauri, Capacitor, Electron).
   */
  onLinkClick?: (url: string) => void;
}

/**
 * React wrapper around a CodeMirror 6 editor configured for markdown
 * editing with Obsidian-style inline live preview. Intentionally
 * minimal while we iterate — no imperative handle, no external-source
 * sync, no search panel wiring. Callers pass content in, receive
 * changes out.
 *
 * Remember to import the accompanying CSS:
 *
 * ```ts
 * import '@atomic/editor/styles.css';
 * ```
 */
export function AtomicCodeMirrorEditor({
  markdownSource,
  documentId,
  onMarkdownChange,
  onLinkClick,
}: AtomicCodeMirrorEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  const onLinkClickRef = useRef(onLinkClick);

  useEffect(() => {
    onMarkdownChangeRef.current = onMarkdownChange;
  }, [onMarkdownChange]);

  useEffect(() => {
    onLinkClickRef.current = onLinkClick;
  }, [onLinkClick]);

  // Mount once per document identity; swapping documents tears down the
  // view so cursor/undo state from the previous doc doesn't leak.
  const editorIdentity = documentId ?? markdownSource;

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
          EditorView.lineWrapping,
          // markdownLanguage enables GFM (tables, strikethrough, task
          // lists, autolinks) on top of CommonMark. Without `base:
          // markdownLanguage`, the parser defaults to pure CommonMark
          // and never emits TaskMarker / Table nodes, so the preview
          // can't style them.
          markdown({ base: markdownLanguage, codeLanguages: ATOMIC_CODE_LANGUAGES }),
          atomicMarkdownSyntax,
          atomicEditorTheme,
          keymap.of([
            ...historyKeymap,
            ...markdownKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          inlinePreview({
            // Stable wrapper: we look up the latest callback from the
            // ref at fire time, so prop changes take effect without
            // remounting the editor.
            onLinkClick: (url) => onLinkClickRef.current?.(url),
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            onMarkdownChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorIdentity]);

  return <div ref={rootRef} className="atomic-cm-editor relative h-full w-full" />;
}

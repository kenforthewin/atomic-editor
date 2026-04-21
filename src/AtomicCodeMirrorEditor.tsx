import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
  type Panel,
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
  redo,
  undo,
} from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';

import { ATOMIC_CODE_LANGUAGES } from './code-languages';
import { atomicEditorTheme, atomicMarkdownSyntax } from './atomic-theme';
import { extendEmphasisPair } from './edit-helpers';
import { imageBlocks } from './image-blocks';
import { inlinePreview } from './inline-preview';
import { tables } from './table-widget';

export interface AtomicCodeMirrorEditorHandle {
  focus: () => void;
  undo: () => void;
  redo: () => void;
  openSearch: (query?: string) => void;
  closeSearch: () => void;
  isSearchOpen: () => boolean;
  getMarkdown: () => string;
  getContentDOM: () => HTMLElement | null;
}

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
   * If set, opens the search panel on mount with this query pre-filled.
   * Useful for landing the reader on a search hit — the user sees their
   * query already active without re-typing.
   */
  initialSearchText?: string | null;

  /**
   * Skip any implicit focus behavior on mount. Defaults to `false`;
   * the CM6 view doesn't auto-focus today, but consumers wiring this
   * into a larger reader often want an explicit escape hatch in case
   * a future extension or keymap does.
   */
  blurEditorOnMount?: boolean;

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

  /**
   * A mutable ref the editor attaches its imperative handle to. Use
   * this for side-effectful ops that don't fit a prop/callback model
   * — keyboard-driven undo/redo, opening the search panel on Ctrl+F
   * from outside the editor, pulling the current markdown on demand.
   */
  editorHandleRef?: MutableRefObject<AtomicCodeMirrorEditorHandle | null>;
}

/**
 * React wrapper around a CodeMirror 6 editor configured for markdown
 * editing with Obsidian-style inline live preview.
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
  initialSearchText,
  blurEditorOnMount,
  onMarkdownChange,
  onLinkClick,
  editorHandleRef,
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
          // Obsidian-style bracket pairing.
          closeBrackets(),
          extendEmphasisPair,
          EditorView.lineWrapping,
          // Find-in-document. `top: true` drops the panel above the
          // editor (matching Obsidian / the prior Milkdown panel).
          // The createPanel wrapper adds a stable class that external
          // code can query to detect "is search open?" without relying
          // on CM6 internals.
          search({
            top: true,
            createPanel: (innerView) => {
              const panel = defaultSearchPanel(innerView);
              panel.dom.classList.add('atomic-editor-search-panel');
              return panel;
            },
          }),
          // GFM via base: markdownLanguage — tables, strikethrough,
          // task lists, autolinks. Without this, the parser is pure
          // CommonMark and inline-preview never sees Task / Table.
          markdown({ base: markdownLanguage, codeLanguages: ATOMIC_CODE_LANGUAGES }),
          // Extend closeBrackets to markdown's symmetric delimiters.
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
          inlinePreview({
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

    if (initialSearchText) {
      // Defer by a tick so the panel mounts after the view's initial
      // layout — otherwise the panel's DOM measurement race can leave
      // it mis-positioned on first paint.
      queueMicrotask(() => {
        if (viewRef.current !== view) return;
        view.dispatch({
          effects: setSearchQuery.of(new SearchQuery({ search: initialSearchText })),
        });
        openSearchPanel(view);
      });
    }

    if (blurEditorOnMount) {
      // No-op under default extensions — CM6 doesn't auto-focus. Kept
      // for API symmetry with the previous Milkdown-based editor, so
      // consumers don't have to special-case this prop when swapping.
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorIdentity]);

  // Publish the imperative handle. Lives in its own effect so changing
  // `editorHandleRef` identity doesn't rebuild the view.
  useEffect(() => {
    if (!editorHandleRef) return;
    editorHandleRef.current = {
      focus: () => viewRef.current?.focus(),
      undo: () => {
        const view = viewRef.current;
        if (view) undo(view);
      },
      redo: () => {
        const view = viewRef.current;
        if (view) redo(view);
      },
      openSearch: (query) => {
        const view = viewRef.current;
        if (!view) return;
        if (query !== undefined) {
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: query })),
          });
        }
        openSearchPanel(view);
      },
      closeSearch: () => {
        const view = viewRef.current;
        if (view) closeSearchPanel(view);
      },
      isSearchOpen: () => {
        const view = viewRef.current;
        return view ? searchPanelOpen(view.state) : false;
      },
      getMarkdown: () => viewRef.current?.state.doc.toString() ?? '',
      getContentDOM: () => viewRef.current?.contentDOM ?? null,
    };
    return () => {
      if (editorHandleRef.current) editorHandleRef.current = null;
    };
  }, [editorHandleRef]);

  return <div ref={rootRef} className="atomic-cm-editor relative h-full w-full" />;
}

// ---------------------------------------------------------------------
// Default search panel builder
//
// CM6's `search` extension doesn't export its internal default panel
// factory, so we build a minimal equivalent that owns the same inputs
// (search text, replace text, case / regex / word toggles) and wires
// them up via the same commands the keymap uses. Building our own
// panel also gives us a hook point to add app-specific classes
// without fighting CM6's defaults.

function defaultSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-search';
  dom.setAttribute('aria-label', 'Find');

  const form = document.createElement('form');
  form.autocomplete = 'off';
  form.addEventListener('submit', (event) => event.preventDefault());

  const currentQuery = getSearchQuery(view.state);

  const searchInput = makeInput('Find', currentQuery.search);
  searchInput.setAttribute('main-field', 'true');
  const replaceInput = makeInput('Replace', currentQuery.replace);

  const caseToggle = makeCheckbox('Match case', currentQuery.caseSensitive);
  const regexToggle = makeCheckbox('Regex', currentQuery.regexp);
  const wordToggle = makeCheckbox('By word', currentQuery.wholeWord);

  const dispatchQuery = () => {
    const query = new SearchQuery({
      search: searchInput.value,
      replace: replaceInput.value,
      caseSensitive: caseToggle.input.checked,
      regexp: regexToggle.input.checked,
      wholeWord: wordToggle.input.checked,
    });
    view.dispatch({ effects: setSearchQuery.of(query) });
  };

  for (const el of [searchInput, replaceInput]) {
    el.addEventListener('input', dispatchQuery);
  }
  for (const tog of [caseToggle, regexToggle, wordToggle]) {
    tog.input.addEventListener('change', dispatchQuery);
  }

  const nextBtn = makeButton('Next', () => findNext(view));
  const prevBtn = makeButton('Previous', () => findPrevious(view));
  const replaceBtn = makeButton('Replace', () => replaceNext(view));
  const replaceAllBtn = makeButton('Replace all', () => replaceAll(view));
  const closeBtn = makeButton('×', () => closeSearchPanel(view));
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.classList.add('cm-atomic-search-close');

  const topRow = document.createElement('div');
  topRow.className = 'cm-atomic-search-row';
  topRow.append(searchInput, prevBtn, nextBtn, closeBtn);

  const replaceRow = document.createElement('div');
  replaceRow.className = 'cm-atomic-search-row';
  replaceRow.append(replaceInput, replaceBtn, replaceAllBtn);

  const togglesRow = document.createElement('div');
  togglesRow.className = 'cm-atomic-search-toggles';
  togglesRow.append(caseToggle.label, regexToggle.label, wordToggle.label);

  form.append(topRow, replaceRow, togglesRow);
  dom.append(form);

  return {
    dom,
    top: true,
    mount: () => {
      searchInput.focus();
      searchInput.select();
    },
  };
}

function makeInput(placeholder: string, value: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.placeholder = placeholder;
  el.value = value;
  el.className = 'cm-atomic-search-input';
  return el;
}

function makeCheckbox(
  label: string,
  checked: boolean,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement('label');
  wrap.className = 'cm-atomic-search-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  wrap.append(input, document.createTextNode(label));
  return { label: wrap, input };
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.className = 'cm-atomic-search-btn';
  el.addEventListener('click', onClick);
  return el;
}

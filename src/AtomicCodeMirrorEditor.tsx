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
import { indentOnInput } from '@codemirror/language';
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
// Search panel
//
// Intentionally minimal: an input, previous / next / close icon
// buttons, and a live match counter. No replace, no case / regex /
// word toggles — reader-first, not editor-first. Keyboard users get
// the same behavior CM6's `searchKeymap` ships with
// (Cmd/Ctrl+G = next, Shift+same = previous, Escape = close).
//
// CM6 doesn't expose a ready-made "minimal" panel, and it doesn't
// expose its default either, so we build our own. Owning the DOM
// also means we can style it to match the rest of the app without
// fighting base CM6 styles.

const SEARCH_ICON_PREV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
const SEARCH_ICON_NEXT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const SEARCH_ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function defaultSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-search';
  dom.setAttribute('aria-label', 'Find');

  const form = document.createElement('form');
  form.autocomplete = 'off';
  // Submit (Enter) on the input advances to the next match — matches
  // the muscle memory of browser find-on-page.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    findNext(view);
  });

  const initial = getSearchQuery(view.state);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search';
  searchInput.value = initial.search;
  searchInput.className = 'cm-atomic-search-input';
  searchInput.setAttribute('main-field', 'true');
  searchInput.setAttribute('aria-label', 'Search');

  const count = document.createElement('span');
  count.className = 'cm-atomic-search-count';
  count.setAttribute('aria-live', 'polite');

  const prevBtn = makeIconButton(
    SEARCH_ICON_PREV,
    'Previous match',
    () => findPrevious(view),
  );
  const nextBtn = makeIconButton(
    SEARCH_ICON_NEXT,
    'Next match',
    () => findNext(view),
  );
  const closeBtn = makeIconButton(
    SEARCH_ICON_CLOSE,
    'Close',
    () => closeSearchPanel(view),
  );

  // Count the matches in the document for the current query. Walks
  // the doc via SearchQuery's cursor (sparse — not every character
  // is visited), so cost is O(matches) rather than O(doc). Atoms
  // are short enough that even a naïve walk would be fine; the
  // cursor form is what CM6 itself uses.
  const recomputeCount = (query: SearchQuery) => {
    if (!query.search) {
      count.textContent = '';
      return;
    }
    try {
      if (!query.valid) {
        count.textContent = '';
        return;
      }
      let n = 0;
      const cursor = query.getCursor(view.state.doc);
      while (!cursor.next().done) {
        n++;
        if (n > 9999) break; // sanity cap for pathological regexes
      }
      count.textContent = n === 0 ? 'No matches' : n === 1 ? '1 match' : `${n} matches`;
    } catch {
      // Regex compile failure — leave the counter blank; user will
      // see the input lacks its "valid" state via the container class.
      count.textContent = '';
    }
  };

  const dispatchQuery = () => {
    const query = new SearchQuery({
      search: searchInput.value,
      caseSensitive: initial.caseSensitive,
      regexp: initial.regexp,
      wholeWord: initial.wholeWord,
    });
    view.dispatch({ effects: setSearchQuery.of(query) });
    recomputeCount(query);
  };

  searchInput.addEventListener('input', dispatchQuery);
  recomputeCount(initial);

  form.append(searchInput, count, prevBtn, nextBtn, closeBtn);
  dom.append(form);

  return {
    dom,
    top: true,
    mount: () => {
      searchInput.focus();
      searchInput.select();
    },
    update: (update) => {
      const next = getSearchQuery(update.state);
      const prev = getSearchQuery(update.startState);
      // Sync the visible input if the query changed from outside
      // the panel — e.g. `openSearch("foo")` dispatched while the
      // panel was already open. Without this, the input shows the
      // old term while Next / Previous operate on the new query.
      // Guard on value inequality so we don't fight a user mid-edit
      // (programmatic .value assignment keeps the caret at the end).
      if (next.search !== prev.search && searchInput.value !== next.search) {
        searchInput.value = next.search;
      }
      // Recount on any query change or doc edit so "N matches"
      // stays live.
      if (update.docChanged || next.search !== prev.search) {
        recomputeCount(next);
      }
    },
  };
}

function makeIconButton(
  svg: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'cm-atomic-search-btn';
  el.innerHTML = svg;
  el.setAttribute('aria-label', label);
  el.title = label;
  el.addEventListener('click', onClick);
  return el;
}

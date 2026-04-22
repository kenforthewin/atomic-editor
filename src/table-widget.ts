import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  Facet,
  Prec,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { treeGrowthEffect, treeProgressPlugin } from './tree-progress';

// GFM tables as a WYSIWYG block widget.
//
// Strategy: replace the entire Table node in the source with a block
// Decoration.replace widget. The widget renders an HTML `<table>`
// whose `<th>` / `<td>` cells are `contenteditable`. Editing flows
// DOM → source: on every cell `input` event we re-serialize the
// widget's DOM state to markdown and dispatch a single change that
// replaces the table's current source range. Source → DOM is handled
// by the StateField rebuilding a widget from the parsed tree, but
// crucially our widget's `eq` is structure-only: same row/col count
// returns true, so CM6 keeps the existing DOM across keystrokes and
// the caret / focus survive.
//
// Tab / Shift-Tab move focus between cells. Tab past the last cell
// appends a new row and focuses its first cell. Backspace/Delete
// inside a cell uses browser default (per-char). Outside the widget
// (at the table's atomic boundary), CM6's atomic-range handling
// deletes the whole table as one unit — matching Obsidian's "table
// is a unit" feel.
//
// Scope cuts deliberately left out of v1:
//   - Column alignment (`:---`, `---:`, `:---:`) — parsed but dropped;
//     all cells render left-aligned.
//   - Rich content inside cells (markdown marks, links, etc.).
//   - Context-menu operations (add/remove row/column, sort).
//   - Multi-line cell content.
// These are incremental, non-architectural adds; they can land later
// without changing the widget's core shape.

// ---- model / parse / serialize --------------------------------------

interface TableModel {
  header: string[];
  rows: string[][];
}

function collectCells(state: EditorState, rowNode: SyntaxNode): string[] {
  const { doc } = state;
  const cells: string[] = [];
  const cursor = rowNode.cursor();
  if (!cursor.firstChild()) return cells;
  do {
    if (cursor.name === 'TableCell') {
      cells.push(doc.sliceString(cursor.from, cursor.to).trim());
    }
  } while (cursor.nextSibling());
  return cells;
}

function parseTable(state: EditorState, tableNode: SyntaxNode): TableModel | null {
  const header: string[] = [];
  const rows: string[][] = [];

  const cursor = tableNode.cursor();
  if (!cursor.firstChild()) return null;

  do {
    if (cursor.name === 'TableHeader') {
      header.push(...collectCells(state, cursor.node));
    } else if (cursor.name === 'TableRow') {
      rows.push(collectCells(state, cursor.node));
    }
    // TableDelimiter (per-row `|` and whole-line `|---|---|`) is ignored.
  } while (cursor.nextSibling());

  if (header.length === 0) return null;
  return { header, rows };
}

function serializeTable(model: TableModel): string {
  const columnCount = model.header.length;
  const lines: string[] = [];
  lines.push('| ' + model.header.join(' | ') + ' |');
  lines.push('| ' + model.header.map(() => '---').join(' | ') + ' |');
  for (const row of model.rows) {
    const padded: string[] = [];
    for (let c = 0; c < columnCount; c++) padded.push(row[c] ?? '');
    lines.push('| ' + padded.join(' | ') + ' |');
  }
  return lines.join('\n');
}

function readModelFromDom(wrap: HTMLElement): TableModel {
  const header = Array.from(wrap.querySelectorAll<HTMLElement>('thead th')).map(
    readCellSource,
  );
  const rows = Array.from(wrap.querySelectorAll<HTMLElement>('tbody tr')).map(
    (tr) =>
      Array.from(tr.querySelectorAll<HTMLElement>('td')).map(readCellSource),
  );
  return { header, rows };
}

// A cell's raw markdown lives in `dataset.raw` — the source of truth
// that `readModelFromDom` reads when serializing the table back to
// markdown. The inner `.cm-atomic-table-cell-source` element displays
// an escape-stripped view of that raw text so RSS-ingested cells
// don't show `\.` / `\(` / `\-` style literal backslashes in the
// reader; the input handler pulls innerText back to dataset.raw on
// every keystroke (any escapes the user types get preserved there,
// but won't round-trip back through stripEscapes on re-render —
// acceptable tradeoff because the escapes are typically ingestion
// artifacts users don't want to preserve anyway).
function readCellSource(cell: HTMLElement): string {
  return (cell.dataset.raw ?? '').trim();
}

function getCellSource(cell: HTMLElement): HTMLElement | null {
  return cell.querySelector<HTMLElement>('.cm-atomic-table-cell-source');
}

// ---- inline-mark parsing for cell source --------------------------------

// Cells render a subset of inline markdown — bold, italic, strikethrough,
// and links. No code spans (the `|` inside a backtick would silently
// break row parsing), no lists/blocks (cells are single-line by
// construction), no images (handled by the separate cell-preview strip).
//
// The parser is recursive so `**[text](url)**` nests cleanly, but each
// mark is a straightforward delimiter pair — no CommonMark flanking
// rules. The UX inside a cell is forgiving on purpose: if a pair
// matches, it decorates.

type CellToken =
  | { type: 'text'; text: string }
  | { type: 'strong'; delim: '**' | '__'; children: CellToken[] }
  | { type: 'em'; delim: '*' | '_'; children: CellToken[] }
  | { type: 'strike'; children: CellToken[] }
  | { type: 'link'; textChildren: CellToken[]; url: string };

function parseCellInline(raw: string): CellToken[] {
  const tokens: CellToken[] = [];
  let textBuf = '';
  let i = 0;

  const flushText = () => {
    if (textBuf.length) {
      tokens.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  while (i < raw.length) {
    // CommonMark backslash escape — the following char is emitted
    // literally and can't open/close a mark. Pair is consumed.
    if (raw[i] === '\\' && i + 1 < raw.length && /[!-/:-@[-`{-~]/.test(raw[i + 1])) {
      textBuf += raw[i + 1];
      i += 2;
      continue;
    }

    const match = matchCellMarkAt(raw, i);
    if (match) {
      flushText();
      tokens.push(match.token);
      i = match.end;
      continue;
    }

    textBuf += raw[i];
    i++;
  }

  flushText();
  return tokens;
}

function matchCellMarkAt(
  raw: string,
  from: number,
): { token: CellToken; end: number } | null {
  const rest = raw.slice(from);

  // Bold with `**` or `__` — greedy on the outside, lazy on the
  // content so we catch the nearest closer.
  let m = rest.match(/^\*\*([\s\S]+?)\*\*/);
  if (m) {
    return {
      token: { type: 'strong', delim: '**', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }
  m = rest.match(/^__([\s\S]+?)__/);
  if (m) {
    return {
      token: { type: 'strong', delim: '__', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }

  // Strikethrough.
  m = rest.match(/^~~([\s\S]+?)~~/);
  if (m) {
    return {
      token: { type: 'strike', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }

  // Link `[text](url)`. Reject empty text / url via `+` quantifiers.
  // `]` and `)` can't appear unescaped inside their respective fields.
  m = rest.match(/^\[([^\]\n]+)\]\(([^\s)"'\n]+)\)/);
  if (m) {
    return {
      token: {
        type: 'link',
        textChildren: parseCellInline(m[1]),
        url: m[2],
      },
      end: from + m[0].length,
    };
  }

  // Italic with `*`. Reject a leading `*` (that would have matched
  // the bold regex above; this guards against pathological inputs
  // like `***` that slip through).
  m = rest.match(/^\*([^*\n]+?)\*/);
  if (m) {
    return {
      token: { type: 'em', delim: '*', children: parseCellInline(m[1]) },
      end: from + m[0].length,
    };
  }

  // Italic with `_`. Avoid triggering inside words like `snake_case`
  // by requiring the char before `_` to not be a word character.
  // (Fallback to true when `_` is at start-of-input.)
  const prev = from > 0 ? raw[from - 1] : '';
  if (!/\w/.test(prev)) {
    m = rest.match(/^_([^_\n]+?)_/);
    if (m) {
      return {
        token: { type: 'em', delim: '_', children: parseCellInline(m[1]) },
        end: from + m[0].length,
      };
    }
  }

  return null;
}

// Build the decorated DOM for a cell's source. The parser strips
// CommonMark backslash escapes inline (so `\*` emits a literal `*`
// text node); the fragment's `textContent` equals the escape-stripped
// raw. The cell's input handler reads `textContent` to update
// `dataset.raw` — round-trip is one-way for escapes (same as the
// pre-markdown-in-cells behavior), but fully preserves every inline
// mark delimiter because those live in `display: none` spans inside
// the DOM rather than being derived on serialize.
function buildCellSourceDom(raw: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const tokens = parseCellInline(raw);
  for (const tok of tokens) frag.appendChild(renderCellToken(tok));
  return frag;
}

function renderCellToken(tok: CellToken): Node {
  if (tok.type === 'text') {
    return document.createTextNode(tok.text);
  }

  if (tok.type === 'strong') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-strong-wrap';
    wrap.appendChild(makeCellMark(tok.delim));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-strong';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark(tok.delim));
    return wrap;
  }

  if (tok.type === 'em') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-em-wrap';
    wrap.appendChild(makeCellMark(tok.delim));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-em';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark(tok.delim));
    return wrap;
  }

  if (tok.type === 'strike') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-strike-wrap';
    wrap.appendChild(makeCellMark('~~'));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-strike';
    inner.appendChild(renderTokensTo(tok.children));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark('~~'));
    return wrap;
  }

  // Link. Shape mirrors the outer-editor markup: `.cm-atomic-link` on
  // the visible text (picks up link color + external-link icon via
  // `::after`), faint marks for `[`, `]`, `(`, URL, `)`. `data-url`
  // lets the cell-source click handler open the right URL without
  // re-parsing.
  const wrap = document.createElement('span');
  wrap.className = 'cm-atomic-link-wrap';
  wrap.dataset.url = tok.url;
  wrap.appendChild(makeCellMark('['));
  const inner = document.createElement('span');
  inner.className = 'cm-atomic-link';
  inner.appendChild(renderTokensTo(tok.textChildren));
  wrap.appendChild(inner);
  wrap.appendChild(makeCellMark(']'));
  wrap.appendChild(makeCellMark('('));
  const urlMark = makeCellMark(tok.url);
  urlMark.classList.add('cm-atomic-link-url');
  wrap.appendChild(urlMark);
  wrap.appendChild(makeCellMark(')'));
  return wrap;
}

function renderTokensTo(tokens: CellToken[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const tok of tokens) frag.appendChild(renderCellToken(tok));
  return frag;
}

function makeCellMark(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'cm-atomic-mark';
  el.textContent = text;
  return el;
}

// Render a cell source element in its decorated form. Safe to call
// multiple times — overwrites whatever was there.
//
// Marks start collapsed: all `.cm-atomic-mark` descendants (delimiters
// like `**`, `_`, `~~`, `[`, `]`, `(`, `)`, and URL text) are hidden
// via CSS by default. When the caret enters a mark wrap, JS adds an
// `active` class that reveals that wrap's delimiters — mirroring the
// outer editor's cursor-inside-link unfold for every inline mark.
function renderCellSourceDecorated(source: HTMLElement): void {
  const raw = source.parentElement?.dataset.raw ?? '';
  source.replaceChildren(buildCellSourceDom(raw));
}

// Caret utilities — encode positions as character offsets within the
// element's textContent so we can survive the full-DOM re-render that
// follows every keystroke (new marks need to decorate immediately;
// the whole tree rebuilds from scratch).

function getCaretCharOffset(container: HTMLElement): number | null {
  const selection = container.ownerDocument?.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaretCharOffset(container: HTMLElement, offset: number): void {
  const doc = container.ownerDocument;
  if (!doc) return;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let target: Text | null = null;
  let targetOffset = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (remaining <= len) {
      target = node;
      targetOffset = remaining;
      break;
    }
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  if (target) {
    range.setStart(target, targetOffset);
  } else {
    // Offset past the end — place caret at the container's end.
    range.selectNodeContents(container);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

const MARK_WRAP_CLASSES = [
  'cm-atomic-strong-wrap',
  'cm-atomic-em-wrap',
  'cm-atomic-strike-wrap',
  'cm-atomic-link-wrap',
];

function isMarkWrap(el: Element): boolean {
  for (const c of MARK_WRAP_CLASSES) if (el.classList.contains(c)) return true;
  return false;
}

// Reveal the delimiters of whatever mark wrap(s) contain the caret,
// and collapse every other wrap in this cell. Walks from the caret
// anchor up to the source element, flagging every ancestor mark wrap
// so nested marks (bold-containing-italic) all reveal together — the
// user sees the full structure around their caret.
function updateActiveMarkForSource(source: HTMLElement): void {
  // Clear existing `active` classes within this cell only — other
  // cells track their own state via their own focus lifecycle.
  for (const el of source.querySelectorAll('.active')) {
    el.classList.remove('active');
  }

  const doc = source.ownerDocument;
  if (!doc) return;
  const selection = doc.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const anchor = selection.anchorNode;
  if (!anchor || !source.contains(anchor)) return;

  let node: Node | null = anchor;
  while (node && node !== source) {
    if (node instanceof Element && isMarkWrap(node)) {
      node.classList.add('active');
    }
    node = node.parentNode;
  }
}

function clearActiveMarksInSource(source: HTMLElement): void {
  for (const el of source.querySelectorAll('.active')) {
    el.classList.remove('active');
  }
}

interface CellImage {
  src: string;
  alt: string;
}

// Scan raw markdown for `![alt](url)` occurrences. The regex bans `]`
// inside the alt and whitespace inside the URL so we fail closed on
// malformed sources rather than embedding a broken preview.
function extractCellImages(text: string): CellImage[] {
  const imgs: CellImage[] = [];
  const re = /!\[([^\]]*)\]\(([^\s)"']+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of text.matchAll(re)) {
    imgs.push({ alt: match[1] || '', src: match[2] });
  }
  return imgs;
}

// Refresh (or remove) the image-preview strip that sits below the
// source line. Mirrors how images render outside tables: the
// `![alt](url)` markdown is the source of truth, but on an inactive
// cell (no focus inside) the raw source hides and only the rendered
// image remains visible. `data-has-image` flips on for that CSS hook.
function refreshCellPreview(cell: HTMLElement): void {
  const existing = cell.querySelector<HTMLElement>('.cm-atomic-table-cell-preview');
  if (existing) existing.remove();

  const text = cell.dataset.raw ?? '';
  const imgs = extractCellImages(text);
  if (imgs.length === 0) {
    delete cell.dataset.hasImage;
    return;
  }
  cell.dataset.hasImage = 'true';

  const preview = document.createElement('div');
  preview.className = 'cm-atomic-table-cell-preview';
  // Preview is visual only — no caret, no contenteditable scope.
  // Keeping it out of contenteditable also means clicking the image
  // won't create a phantom caret position at the preview boundary.
  preview.contentEditable = 'false';

  for (const { src, alt } of imgs) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.loading = 'lazy';
    img.className = 'cm-atomic-table-cell-image';
    // Clicking the image puts the caret in the source text so the
    // user can edit the underlying markdown — same affordance as
    // clicking a block-level image outside a table.
    img.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const source = getCellSource(cell);
      if (!source) return;
      source.focus();
      placeCaretAtEnd(source);
    });
    preview.appendChild(img);
  }

  cell.appendChild(preview);
}

// ---- position resolution --------------------------------------------

// posAtDOM on a block-replace widget returns the start of the replaced
// range. Walk the tree from there to find the enclosing Table node so
// our dispatch targets the current range (positions shift as the user
// types — we can't rely on the from/to captured at widget creation).
function findCurrentTableRange(
  view: EditorView,
  dom: HTMLElement,
): { from: number; to: number } | null {
  const pos = view.posAtDOM(dom);
  if (pos < 0) return null;
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node && node.name !== 'Table') node = node.parent;
  if (node) return { from: node.from, to: node.to };

  // Fallback: scan for the nearest Table node containing or starting
  // at pos. Rare — resolveInner + parent walk handles almost every
  // case — but guards against parser edge cases.
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter: (n) => {
      if (n.name !== 'Table') return;
      if (n.from <= pos && n.to >= pos) {
        found = n.node;
        return false;
      }
    },
  });
  if (found) return { from: (found as SyntaxNode).from, to: (found as SyntaxNode).to };
  return null;
}

// ---- DOM helpers ----------------------------------------------------

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function getAllCells(wrap: HTMLElement): HTMLElement[] {
  return Array.from(wrap.querySelectorAll<HTMLElement>('th, td'));
}

// ---- widget ---------------------------------------------------------

class TableWidget extends WidgetType {
  constructor(readonly model: TableModel) {
    super();
  }

  // Structure-only equality. Typing in a cell produces a new
  // TableWidget with the same dimensions but different cell contents.
  // Returning true here means CM6 keeps the existing DOM instead of
  // calling `toDOM` again — which is what lets the caret survive
  // across the per-keystroke dispatch cycle.
  eq(other: TableWidget): boolean {
    if (other.model.header.length !== this.model.header.length) return false;
    if (other.model.rows.length !== this.model.rows.length) return false;
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-atomic-table';

    const table = document.createElement('table');
    wrap.appendChild(table);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const text of this.model.header) {
      headerRow.appendChild(makeCell('th', text, view));
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const colCount = this.model.header.length;
    for (const row of this.model.rows) {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        tr.appendChild(makeCell('td', row[c] ?? '', view));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    return wrap;
  }

  // All cell interactions are handled by the listeners we attach in
  // `makeCell`; tell CM6 to stay out of events within the widget so
  // its own selection/click logic doesn't compete with contenteditable.
  ignoreEvent(): boolean {
    return true;
  }
}

function makeCell(
  tag: 'th' | 'td',
  text: string,
  view: EditorView,
): HTMLElement {
  const cell = document.createElement(tag);
  cell.dataset.raw = text;

  // The cell itself is not contenteditable — only the inner source
  // element is. This keeps the image preview strictly visual (no
  // phantom caret positions around images) while the source text
  // stays in a dedicated editable box above it.
  const source = document.createElement('div');
  source.className = 'cm-atomic-table-cell-source';
  source.contentEditable = 'true';
  source.spellcheck = true;
  // Decorated DOM on mount. Delimiters (`.cm-atomic-mark`) are
  // `display: none` by default — the caret can't navigate into them,
  // the reader sees a clean rendered view. When the caret enters a
  // mark wrap, JS adds `.active` to reveal that wrap's delimiters —
  // matching the outer-editor cursor-inside-link unfold, applied
  // uniformly to every inline mark inside cells.
  cell.appendChild(source);
  renderCellSourceDecorated(source);

  source.addEventListener('input', () => {
    // textContent (not innerText) so `display: none` delimiters
    // inside mark wraps are still captured — otherwise a cell
    // containing `**bold**` would serialize to just `bold` and the
    // marks would vanish on every keystroke.
    const raw = (source.textContent ?? '').replace(/\s+/g, ' ').trim();
    cell.dataset.raw = raw;

    // Re-parse + re-render so marks the user typed (e.g. a new pair
    // of `**`) decorate immediately. Caret offset preserved across
    // the DOM rebuild.
    const offset = getCaretCharOffset(source);
    renderCellSourceDecorated(source);
    if (offset != null) setCaretCharOffset(source, offset);
    updateActiveMarkForSource(source);

    refreshCellPreview(cell);
    dispatchModelFromDom(view, cell);
  });

  // Caret-position listeners. `focus` / `mouseup` / `keyup` cover the
  // three ways the caret can land in a new mark without firing an
  // input event (click-to-place, arrow-key nav, tab-into-cell). The
  // update is idempotent — redundant calls cost nothing.
  source.addEventListener('focus', () => updateActiveMarkForSource(source));
  source.addEventListener('mouseup', () => updateActiveMarkForSource(source));
  source.addEventListener('keyup', () => updateActiveMarkForSource(source));

  // Blur: collapse every active wrap so the reader-resting state
  // hides all delimiters.
  source.addEventListener('blur', () => clearActiveMarksInSource(source));

  source.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      moveCellFocus(view, cell, event.shiftKey ? -1 : 1);
    }
  });

  cell.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCellMenu(view, cell, event.clientX, event.clientY);
  });

  // Link-icon click: in the unfocused (decorated) state, a click
  // inside a `.cm-atomic-link` span's trailing external-link icon
  // zone should open the URL instead of placing the caret. Matches
  // the outer-editor click handler's icon-zone convention so users
  // get a consistent affordance inside and outside tables.
  //
  // `pointerdown` (not click) so we can `preventDefault` to block
  // focus + caret placement before the browser reacts.
  source.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const linkWrap = target.closest<HTMLElement>('.cm-atomic-link-wrap');
    if (!linkWrap) return;
    const linkEl = linkWrap.querySelector<HTMLElement>('.cm-atomic-link');
    if (!linkEl) return;

    const rects = Array.from(linkEl.getClientRects());
    if (rects.length === 0) return;
    const lastRect = rects[rects.length - 1];
    const emSize = parseFloat(window.getComputedStyle(linkEl).fontSize);
    const iconZone = emSize * 1.25;
    const onIcon =
      event.clientX >= lastRect.right - iconZone &&
      event.clientX <= lastRect.right &&
      event.clientY >= lastRect.top &&
      event.clientY <= lastRect.bottom;
    if (!onIcon) return;

    const url = linkWrap.dataset.url;
    if (!url) return;

    event.preventDefault();
    event.stopPropagation();
    view.state.facet(tableLinkClickFacet)(url);
  });

  // When the cell has an image and the source is visually hidden,
  // clicks land on the cell/image/empty space but not on the source
  // itself. Route every pointerdown inside the cell to a focus on
  // the source so the user can edit regardless of where they tapped.
  // The image's own pointerdown handler already does this, but
  // covers only image hits — this covers empty padding and the
  // space between/around images.
  cell.addEventListener('pointerdown', (event) => {
    if (event.target === source) return;
    event.preventDefault();
    source.focus();
    placeCaretAtEnd(source);
  });

  refreshCellPreview(cell);

  return cell;
}

// ---- context menu -------------------------------------------------

function cellRowIndex(cell: HTMLElement): number {
  // Rows are indexed within tbody (header isn't a "row" we can
  // insert-above; header context items are column-only).
  const tr = cell.closest<HTMLElement>('tr');
  const tbody = tr?.closest<HTMLElement>('tbody');
  if (!tr || !tbody) return -1;
  return Array.from(tbody.querySelectorAll<HTMLElement>('tr')).indexOf(tr);
}

function cellColIndex(cell: HTMLElement): number {
  const tr = cell.closest<HTMLElement>('tr');
  if (!tr) return -1;
  return Array.from(tr.querySelectorAll<HTMLElement>('th, td')).indexOf(cell);
}

function dispatchModel(
  view: EditorView,
  wrap: HTMLElement,
  nextModel: TableModel,
): void {
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const next = serializeTable(nextModel);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
  });
}

function openCellMenu(
  view: EditorView,
  cell: HTMLElement,
  x: number,
  y: number,
): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const isHeader = cell.tagName === 'TH';
  const row = cellRowIndex(cell);
  const col = cellColIndex(cell);

  const menu = document.createElement('div');
  menu.className = 'cm-atomic-table-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  type MenuItem = { label: string; action: () => void } | 'separator';
  const items: MenuItem[] = [];

  if (!isHeader) {
    items.push({
      label: 'Insert row above',
      action: () => {
        const m = readModelFromDom(wrap);
        m.rows.splice(row, 0, m.header.map(() => ''));
        dispatchModel(view, wrap, m);
      },
    });
    items.push({
      label: 'Insert row below',
      action: () => {
        const m = readModelFromDom(wrap);
        m.rows.splice(row + 1, 0, m.header.map(() => ''));
        dispatchModel(view, wrap, m);
      },
    });
    items.push({
      label: 'Delete row',
      action: () => {
        const m = readModelFromDom(wrap);
        if (row >= 0 && row < m.rows.length) m.rows.splice(row, 1);
        dispatchModel(view, wrap, m);
      },
    });
    items.push('separator');
  }

  items.push({
    label: 'Insert column left',
    action: () => {
      const m = readModelFromDom(wrap);
      m.header.splice(col, 0, '');
      for (const r of m.rows) r.splice(col, 0, '');
      dispatchModel(view, wrap, m);
    },
  });
  items.push({
    label: 'Insert column right',
    action: () => {
      const m = readModelFromDom(wrap);
      m.header.splice(col + 1, 0, '');
      for (const r of m.rows) r.splice(col + 1, 0, '');
      dispatchModel(view, wrap, m);
    },
  });
  items.push({
    label: 'Delete column',
    action: () => {
      const m = readModelFromDom(wrap);
      // Guard: don't leave the table with zero columns — lezer
      // wouldn't re-parse that as a Table and the widget would
      // vanish mid-edit. Keeping the last column as the floor.
      if (m.header.length <= 1 || col < 0) return;
      m.header.splice(col, 1);
      for (const r of m.rows) r.splice(col, 1);
      dispatchModel(view, wrap, m);
    },
  });

  const dismiss = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  };
  const onDocDown = (event: MouseEvent) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    dismiss();
  };
  const onDocKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismiss();
  };

  for (const item of items) {
    if (item === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'cm-atomic-table-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-atomic-table-menu-item';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      item.action();
      dismiss();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Clip the menu inside the viewport if it overflows.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  }

  // Deferred listener attach so the current contextmenu→document
  // mousedown cycle doesn't immediately dismiss us.
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }, 0);
}

function dispatchModelFromDom(view: EditorView, cell: HTMLElement): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;

  const model = readModelFromDom(wrap);
  const next = serializeTable(model);
  // Guard against no-op dispatches.
  if (view.state.sliceDoc(range.from, range.to) === next) return;

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
  });
}

function moveCellFocus(view: EditorView, cell: HTMLElement, dir: 1 | -1): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const cells = getAllCells(wrap);
  const idx = cells.indexOf(cell);
  if (idx < 0) return;

  const next = idx + dir;
  if (next < 0) {
    // Shift-Tab from the first cell — blur the source; let the
    // browser decide where focus goes next (probably the previous
    // focusable element on the page). CM6 keeps its own selection
    // where it was.
    getCellSource(cell)?.blur();
    return;
  }
  if (next >= cells.length) {
    // Tab past the last cell — append a new empty row and focus its
    // first cell. We dispatch through the same path as a cell edit,
    // then grab the new first cell after the DOM reconciles.
    appendRow(view, wrap);
    return;
  }
  const source = getCellSource(cells[next]);
  if (!source) return;
  source.focus();
  placeCaretAtEnd(source);
}

function appendRow(view: EditorView, wrap: HTMLElement): void {
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const model = readModelFromDom(wrap);
  model.rows.push(model.header.map(() => ''));
  const next = serializeTable(model);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
  });

  // Adding a row changes the widget's row count, so `eq` returns
  // false and CM6 rebuilds the widget DOM. The old `wrap` reference
  // is now detached. Wait for the paint that attaches the new DOM,
  // then look up the fresh widget by position and focus its new
  // last-row cell. Double-rAF because the first rAF only guarantees
  // CM6 has processed the dispatch; the second ensures the layout
  // has painted so focus commands don't get lost.
  const { from } = range;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const tables = Array.from(
        view.dom.querySelectorAll<HTMLElement>('.cm-atomic-table'),
      );
      let target: HTMLElement | null = null;
      for (const el of tables) {
        try {
          if (view.posAtDOM(el) === from) {
            target = el;
            break;
          }
        } catch {
          // posAtDOM can throw on detached/transitional DOM nodes
          // — skip and keep looking.
        }
      }
      if (!target) return;
      const rows = target.querySelectorAll<HTMLElement>('tbody tr');
      const newRow = rows[rows.length - 1];
      const firstCell = newRow?.querySelector<HTMLElement>('td');
      const firstSource = firstCell ? getCellSource(firstCell) : null;
      if (!firstSource) return;
      firstSource.focus();
      placeCaretAtEnd(firstSource);
    });
  });
}

// Backspace at the line immediately after a table normally deletes
// the `\n` separator and merges the line-below into the table's last
// source line. Lezer then re-parses the merged content as part of
// the table (or mangles it), producing the "swallow" behavior where
// content below the table looks like it's been absorbed as new rows.
//
// Instead, when the caret sits right after a Table and the user hits
// backspace, select the whole Table range — same pattern Obsidian
// uses for treating the table as an atomic unit for deletion. The
// caller can press backspace again to actually delete the selected
// table.
function backspaceAtTableBoundary(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  if (pos === 0) return false;

  const tree = syntaxTree(state);
  let tableBefore: SyntaxNode | null = null;

  // Scan a few positions back for a Table whose end is adjacent to
  // the caret. `table.to` is the position just after the table's
  // last character — if the caret sits on the next line, `pos` will
  // be one past `table.to` (the \n separator at `table.to` + start
  // of the line after). Accept both.
  tree.iterate({
    from: Math.max(0, pos - 2),
    to: pos,
    enter: (n) => {
      if (n.name !== 'Table') return;
      if (n.to === pos || n.to + 1 === pos) {
        tableBefore = n.node;
      }
    },
  });

  if (!tableBefore) return false;

  const range: SyntaxNode = tableBefore;
  view.dispatch({
    selection: EditorSelection.range(range.from, range.to),
  });
  return true;
}

// ---- state field ----------------------------------------------------

function buildTableWidgets(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // Force full-doc parse so tables past the initial parsed region
  // also get the widget treatment. This StateField only rebuilds on
  // doc change; CM6's background parser advancing the tree later
  // doesn't retrigger it, so a partial tree at mount means orphaned
  // `| col |` raw lines for the rest of the session. 200ms budget
  // bounds the worst case on very long atoms.
  const tree =
    ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const doc = state.doc;

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      const model = parseTable(state, node.node);
      if (!model) return;

      // Block-replace needs whole-line coverage.
      const startLine = doc.lineAt(node.from);
      const endLine = doc.lineAt(node.to);
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(model),
          block: true,
        }).range(startLine.from, endLine.to),
      );
      return false; // don't descend
    },
  });

  return Decoration.set(ranges, true);
}

// Detect whether a doc change could have added, removed, or modified
// a Table node. Two cheap signals:
//
//   1. Any existing table decoration overlaps the changed range
//      (edit to / deletion of an existing table).
//   2. Any line touched by the change contains a pipe `|`. GFM
//      tables are pipe-delimited, so every table line has one and
//      editing one without touching a pipe character is impossible.
//      Prose rarely contains pipes; the occasional false positive
//      is fine because `buildTableWidgets` fails cleanly when
//      lezer didn't emit a Table.
//
// If neither fires, skip the full-doc walk and just map existing
// decorations through the change.
function changeAffectsTables(tr: Transaction, existing: DecorationSet): boolean {
  let affected = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (affected) return;
    existing.between(fromA, toA, () => {
      affected = true;
      return false;
    });
  });
  if (affected) return true;

  const state = tr.state;
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (affected) return;
    const startLine = state.doc.lineAt(fromB);
    const endLine = toB > startLine.to ? state.doc.lineAt(toB) : startLine;
    for (let n = startLine.number; n <= endLine.number; n++) {
      if (state.doc.line(n).text.includes('|')) {
        affected = true;
        break;
      }
    }
  });
  return affected;
}

const tableField = StateField.define<DecorationSet>({
  create: (state) => buildTableWidgets(state),
  update(deco, tr) {
    // Tree-growth effect: lezer's background parser caught up to a
    // region that wasn't parsed when we last built. Rebuild so any
    // newly-visible Table nodes get their widget.
    for (const effect of tr.effects) {
      if (effect.is(treeGrowthEffect)) return buildTableWidgets(tr.state);
    }
    if (!tr.docChanged) return deco;
    const mapped = deco.map(tr.changes);
    if (!changeAffectsTables(tr, deco)) return mapped;
    return buildTableWidgets(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface TablesConfig {
  /**
   * Called when the user clicks the external-link icon on a link
   * rendered inside a table cell. Defaults to `window.open(url,
   * '_blank', 'noopener,noreferrer')`.
   */
  onLinkClick?: (url: string) => void;
}

const defaultLinkOpener = (url: string): void => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // window.open can throw in sandboxed iframes etc.
  }
};

// Per-view facet so `makeCell`'s pointerdown handler can look up the
// current link-click callback. Avoids threading the config through the
// widget constructor and toDOM args.
export const tableLinkClickFacet = Facet.define<
  (url: string) => void,
  (url: string) => void
>({
  combine: (values) => values[0] ?? defaultLinkOpener,
});

export function tables(config: TablesConfig = {}): Extension {
  return [
    tableField,
    treeProgressPlugin,
    ...(config.onLinkClick ? [tableLinkClickFacet.of(config.onLinkClick)] : []),
    // Prec.high so we run before the default Backspace binding.
    Prec.high(keymap.of([{ key: 'Backspace', run: backspaceAtTableBoundary }])),
  ];
}

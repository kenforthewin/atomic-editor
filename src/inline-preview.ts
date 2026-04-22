import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

// Inline preview — the Obsidian "Live Preview" model.
//
// Goals:
//   1. No layout shifts between active/inactive state. The raw markdown
//      source is always the DOM text; we only apply line-level CSS
//      classes (setting font-size / weight unconditionally) and hide
//      syntax tokens on inactive lines via empty Decoration.replace.
//      Line heights are driven by CSS class, not by token visibility.
//
//   2. No reveal during mouse interaction. Clicking a heading places the
//      cursor on its line, which would normally "reveal" the `# ` prefix
//      — and that reveal shifts the heading text rightward under the
//      user's cursor, sometimes turning a click into a micro-drag.
//      Obsidian sidesteps this by delaying the reveal until the mouse
//      has been released for a moment; we do the same via a freeze flag.

export interface InlinePreviewConfig {
  /**
   * Called when the user plain-clicks a rendered link. Defaults to
   * `window.open(url, '_blank', 'noopener,noreferrer')`. Consumers in
   * platform-specific shells (Tauri, Electron, Capacitor) should pass
   * their own opener so links route through the host's external-URL
   * mechanism.
   */
  onLinkClick?: (url: string) => void;
}

function defaultOnLinkClick(url: string): void {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // window.open can throw in sandboxed iframes etc. — silent failure
    // is fine; the caller can supply an opener that handles this.
  }
}

const FREEZE_TAIL_MS = 100;

// ---- freeze plumbing -----------------------------------------------------

const setFrozen = StateEffect.define<boolean>();

const previewFrozenField = StateField.define<boolean>({
  create: () => false,
  update(prev, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFrozen)) return effect.value;
    }
    return prev;
  },
});

// Tracks mouse state on the editor and drives the freeze flag. We listen
// on the content DOM for pointerdown and on the window for pointerup —
// users can release outside the editor after a drag, and we'd miss the
// up event if we listened on the content DOM only.
const freezeMousePlugin = ViewPlugin.fromClass(
  class {
    private down = false;
    private releaseTimer: number | null = null;
    private readonly onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // Only freeze when the pointerdown lands inside the content. The
      // scrollbar (on the outer .cm-scroller) would otherwise engage the
      // freeze too — which keeps decorations stale for the whole drag
      // and the syntax only "pops in" on release. Gesture/wheel scroll
      // doesn't have this issue because it never fires a pointerdown on
      // the scrollbar chrome.
      const target = event.target;
      if (!(target instanceof Node) || !this.view.contentDOM.contains(target)) {
        return;
      }
      this.down = true;
      if (this.releaseTimer != null) {
        window.clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
      }
      if (!this.view.state.field(previewFrozenField)) {
        this.view.dispatch({ effects: setFrozen.of(true) });
      }
    };
    private readonly onUp = () => {
      if (!this.down) return;
      this.down = false;
      if (this.releaseTimer != null) window.clearTimeout(this.releaseTimer);
      this.releaseTimer = window.setTimeout(() => {
        this.releaseTimer = null;
        if (!this.view.state.field(previewFrozenField)) return;
        try {
          this.view.dispatch({ effects: setFrozen.of(false) });
        } catch {
          // view destroyed while timer was pending.
        }
      }, FREEZE_TAIL_MS);
    };

    constructor(readonly view: EditorView) {
      // Capture-phase listener on view.dom so we dispatch setFrozen(true)
      // BEFORE CM6's own pointerdown handler runs its selection logic.
      // Without capture, CM6's listener can win the order race and
      // rebuild decorations (revealing `# `/`**`) before we freeze.
      view.dom.addEventListener('pointerdown', this.onDown, true);
      window.addEventListener('pointerup', this.onUp);
      window.addEventListener('pointercancel', this.onUp);
    }

    update(_: ViewUpdate) {
      // No-op — we don't drive freeze off doc changes.
    }

    destroy() {
      this.view.dom.removeEventListener('pointerdown', this.onDown, true);
      window.removeEventListener('pointerup', this.onUp);
      window.removeEventListener('pointercancel', this.onUp);
      if (this.releaseTimer != null) window.clearTimeout(this.releaseTimer);
    }
  },
);

// ---- decoration building --------------------------------------------------

const LINE_CLASS_BY_BLOCK: Record<string, string> = {
  ATXHeading1: 'cm-atomic-h1',
  ATXHeading2: 'cm-atomic-h2',
  ATXHeading3: 'cm-atomic-h3',
  ATXHeading4: 'cm-atomic-h4',
  ATXHeading5: 'cm-atomic-h5',
  ATXHeading6: 'cm-atomic-h6',
  SetextHeading1: 'cm-atomic-h1',
  SetextHeading2: 'cm-atomic-h2',
  Blockquote: 'cm-atomic-blockquote',
  FencedCode: 'cm-atomic-fenced-code',
};

const HIDEABLE_SYNTAX = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'CodeInfo',
  'LinkMark',
  'URL',
  'LinkTitle',
  'StrikethroughMark',
  'QuoteMark',
]);

const INLINE_MARK_CLASS: Record<string, string> = {
  StrongEmphasis: 'cm-atomic-strong',
  Emphasis: 'cm-atomic-em',
  InlineCode: 'cm-atomic-inline-code',
  Strikethrough: 'cm-atomic-strike',
  Link: 'cm-atomic-link',
};

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    // The `.cm-atomic-list-marker` class is what forces the
    // uniform 1.2em inline-block alcove shared by bullets, task
    // checkboxes, and ordered-list numbers. `.cm-atomic-bullet`
    // layers on bullet-specific color / weight.
    const span = document.createElement('span');
    span.className = 'cm-atomic-list-marker cm-atomic-bullet';
    span.textContent = '•';
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const BULLET_WIDGET = new BulletWidget();

class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    // The `.cm-atomic-list-marker` class provides the uniform
    // inline-block alcove shared by bullets, checkboxes, and
    // ordered numbers. We apply it directly to the `<input>` so
    // selectors like `input.cm-atomic-task-checkbox` still work
    // (a wrapper span broke a Playwright probe that targets the
    // input by its class).
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-atomic-list-marker cm-atomic-task-checkbox';
    input.setAttribute('contenteditable', 'false');
    input.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    input.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(input);
      if (pos < 0) return;
      const current = view.state.doc.sliceString(pos, pos + 3);
      const next = /\[x\]/i.test(current) ? '[ ]' : '[x]';
      if (current === next) return;
      view.dispatch({ changes: { from: pos, to: pos + 3, insert: next } });
    });
    return input;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

function buildInlineDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const ranges: Range<Decoration>[] = [];

  const activeLines = new Set<number>();
  if (view.hasFocus) {
    for (const r of state.selection.ranges) {
      const firstLine = doc.lineAt(r.from).number;
      const lastLine = doc.lineAt(r.to).number;
      for (let n = firstLine; n <= lastLine; n++) activeLines.add(n);
    }
  }

  // Decorate the whole parsed tree — not the current viewport — so
  // that scrolling never needs to rebuild the decoration set. Prior
  // design walked viewport-only and rebuilt on every scroll, which
  // on iOS caused scroll-up momentum halts whenever new decorations
  // were applied to lines at the top of the viewport (anchor
  // conflict with the scroll animation). Cost: a one-shot whole-doc
  // walk on every doc / selection / focus change instead of a
  // smaller walk on every scroll.
  //
  // `ensureSyntaxTree(..., doc.length, ...)` guarantees the tree
  // actually covers the whole doc before we walk it. Without this,
  // for moderately long atoms the incremental parser's initial
  // pass falls short of the end, we'd walk only a prefix, and
  // content past that point renders as raw `##`/`**` forever —
  // decorations don't rebuild on scroll anymore. Subsequent calls
  // are near-free because ensureSyntaxTree short-circuits once the
  // tree reaches the target.
  const tree =
    ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);

  const taskMarkerByLine = new Map<number, number>();
  tree.iterate({
    enter: (node) => {
      if (node.name === 'FencedCode') {
        const firstLine = doc.lineAt(node.from).number;
        const lastLine = doc.lineAt(node.to).number;
        let anyActive = false;
        for (let n = firstLine; n <= lastLine; n++) {
          if (activeLines.has(n)) {
            anyActive = true;
            break;
          }
        }
        if (anyActive) {
          for (let n = firstLine; n <= lastLine; n++) activeLines.add(n);
        }
      } else if (node.name === 'TaskMarker') {
        taskMarkerByLine.set(doc.lineAt(node.from).number, node.from);
      }
    },
  });

  tree.iterate({
    enter: (node) => {
      const lineClass = LINE_CLASS_BY_BLOCK[node.name];
      if (lineClass) {
        const firstLine = doc.lineAt(node.from);
        const lastLine = doc.lineAt(node.to);
        for (let n = firstLine.number; n <= lastLine.number; n++) {
          const line = doc.line(n);
          ranges.push(Decoration.line({ class: lineClass }).range(line.from));
        }
      }

      const markClass = INLINE_MARK_CLASS[node.name];
      if (markClass && node.from < node.to) {
        ranges.push(Decoration.mark({ class: markClass }).range(node.from, node.to));
      }

      if (HIDEABLE_SYNTAX.has(node.name) && node.from < node.to) {
        const lineNum = doc.lineAt(node.from).number;
        if (!activeLines.has(lineNum)) {
          let hideTo = node.to;
          if (node.name === 'HeaderMark' || node.name === 'QuoteMark') {
            while (hideTo < doc.length && doc.sliceString(hideTo, hideTo + 1) === ' ') {
              hideTo++;
            }
          }
          ranges.push(Decoration.replace({}).range(node.from, hideTo));
        }
      }

      // Backslash escapes: `\.`, `\*`, `\(`, etc. RSS-to-markdown
      // converters escape a lot of punctuation defensively, and the
      // backslashes show through as literal chars without preview.
      // Hide just the leading backslash on inactive lines so the
      // escaped character remains visible — mirrors how Obsidian
      // renders escapes. The Escape node spans both characters
      // (`\` + escaped char), so we only replace the first position.
      if (node.name === 'Escape' && node.to - node.from >= 2) {
        const lineNum = doc.lineAt(node.from).number;
        if (!activeLines.has(lineNum)) {
          ranges.push(Decoration.replace({}).range(node.from, node.from + 1));
        }
      }

      if (node.name === 'ListMark' && node.from < node.to) {
        const line = doc.lineAt(node.from);
        const lineNum = line.number;
        const taskFrom = taskMarkerByLine.get(lineNum);

        // Hanging-indent every list item. Layout:
        //
        //   <--BASE--><--ALCOVE--> first-line text
        //             •            wrapped lines land at the
        //                          same column as the first-line
        //                          text, not back under the marker
        //
        // ALCOVE_EM is a fixed 1.2em regardless of list kind.
        // Every marker (bullet widget, checkbox widget, ordered
        // number via mark decoration) is forced into an
        // inline-block of exactly that width via CSS — so the
        // alignment math doesn't depend on per-font marker
        // widths. `padding-left` sets the content column;
        // negative `text-indent` of the same magnitude pulls the
        // first line back so the marker lands in the alcove.
        const rawIndent = node.from - line.from;
        const depth = Math.max(0, Math.floor(rawIndent / 2));
        const BASE_EM = 0.8;
        const ALCOVE_EM = 0.9;
        const LEVEL_EM = 0.6;
        const padding = BASE_EM + ALCOVE_EM + depth * LEVEL_EM;
        ranges.push(
          Decoration.line({
            attributes: {
              style: `padding-left: ${padding}em; text-indent: -${ALCOVE_EM}em`,
            },
          }).range(line.from),
        );

        // Figure out how far past node.to the mark's trailing
        // space lives. For tasks, CM6 pre-computed taskFrom as
        // the start of the `[ ]`; the `- ` span runs from
        // node.from to taskFrom, which already covers the space.
        // For bullets / ordered, include a single trailing space
        // if present so text flows from padding-left without a
        // spurious leading space.
        const hasTrailingSpace =
          doc.sliceString(node.to, node.to + 1) === ' ';
        const markEnd = hasTrailingSpace ? node.to + 1 : node.to;

        if (taskFrom !== undefined) {
          // Hide `- ` (ListMark through the space before `[`).
          ranges.push(Decoration.replace({}).range(node.from, taskFrom));
        } else {
          const markText = doc.sliceString(node.from, node.to);
          if (markText === '-' || markText === '*' || markText === '+') {
            // Bullet: substitute with the fixed-width marker
            // widget, swallowing the trailing space so content
            // starts precisely at padding-left.
            ranges.push(
              Decoration.replace({ widget: BULLET_WIDGET }).range(
                node.from,
                markEnd,
              ),
            );
          } else {
            // Ordered list (or anything else with a non-standard
            // mark text like `1.`, `42.`): keep the text visible
            // but mark it so CSS gives it the same fixed-width
            // alcove. Hide the trailing space separately so the
            // total marker-plus-space footprint matches ALCOVE.
            ranges.push(
              Decoration.mark({ class: 'cm-atomic-list-marker' }).range(
                node.from,
                node.to,
              ),
            );
            if (hasTrailingSpace) {
              ranges.push(Decoration.replace({}).range(node.to, markEnd));
            }
          }
        }
      }

      // Tables are rendered by the separate `tables()` block-widget
      // extension (./table-widget.ts) — the whole Table range is
      // replaced with an interactive HTML `<table>`. Any inline
      // decorations on TableHeader/TableRow/TableDelimiter would
      // target ranges that are already hidden behind the replace
      // widget, so they're intentionally absent from this builder.

      if (node.name === 'HorizontalRule') {
        // CommonMark HR: a line of `***`, `---`, or `___` (3+, any
        // spacing between). On inactive lines we hide the characters
        // and render a horizontal rule via CSS `::after`. On active
        // lines we leave the raw characters visible so the user can
        // edit the marker without it vanishing.
        const line = doc.lineAt(node.from);
        if (!activeLines.has(line.number)) {
          ranges.push(Decoration.line({ class: 'cm-atomic-hr' }).range(line.from));
          ranges.push(Decoration.replace({}).range(line.from, line.to));
        }
      }

      if (node.name === 'Image' && node.from < node.to) {
        const imageLine = doc.lineAt(node.from);
        const lineNum = imageLine.number;
        if (!activeLines.has(lineNum)) {
          // Hide the raw `![alt](url)` on inactive lines so only the
          // rendered image block (emitted by the image-blocks state
          // field below the line) shows. We deliberately keep the
          // now-empty source `.cm-line` at its default line-height
          // rather than collapsing it via `display: none`: on iOS
          // Safari, toggling a line from its text-measured height
          // to zero mid-scroll shifts every subsequent line up by
          // that amount, which the scroll engine reads as an
          // anchor conflict and halts kinetic momentum — visible
          // as "scroll stops right before an image when you scroll
          // back up." The tradeoff is one line of empty space
          // above each rendered image, which actually reads a bit
          // cleaner as visual separation anyway.
          ranges.push(Decoration.replace({}).range(node.from, node.to));
        }
      }

      if (node.name === 'TaskMarker' && node.from < node.to) {
        const markText = doc.sliceString(node.from, node.to);
        const checked = /\[x\]/i.test(markText);
        ranges.push(
          Decoration.replace({ widget: new TaskCheckboxWidget(checked) }).range(
            node.from,
            node.to,
          ),
        );
        if (checked) {
          const lineNum = doc.lineAt(node.from).number;
          const line = doc.line(lineNum);
          ranges.push(
            Decoration.line({ class: 'cm-atomic-task-done' }).range(line.from),
          );
        }
      }
    },
  });

  // Supplemental inline marks for the line containing the cursor.
  // CommonMark's flanking rules say that `**foo **` is not emphasis
  // because the closing `**` is preceded by whitespace — lezer
  // agrees and doesn't emit `StrongEmphasis`, so the walk above
  // misses it. Result: while the user types a sentence inside
  // `**...**`, the bold styling flicks on and off every time they
  // hit the spacebar. We patch the UX by scanning the active line
  // for matched delimiter pairs the cursor sits between and
  // emitting the mark ourselves regardless of flanking. Once the
  // cursor leaves, lezer's opinion wins and the visual reverts to
  // what will actually persist when the line is serialized.
  if (view.hasFocus) {
    const head = state.selection.main.head;
    const line = doc.lineAt(head);
    if (activeLines.has(line.number)) {
      supplementMidTypingEmphasis(
        line.text,
        line.from,
        head - line.from,
        ranges,
      );
    }
  }

  return Decoration.set(ranges, true);
}

// Delimiters we emit supplemental marks for, longest first so `**`
// is matched before `*` and `__` before `_`. Backticks don't need
// this treatment — CommonMark inline code isn't subject to
// flanking rules. Each entry carries both the content class (what
// lezer would style via `t.strong` / `t.emphasis` / `t.strikethrough`)
// and the delimiter class (matches how the EmphasisMark token
// renders when lezer *does* parse: parent tag's weight / style /
// decoration plus `processingInstruction`'s faint color).
const MID_TYPING_DELIMITERS: readonly {
  delim: string;
  contentCls: string;
  delimCls: string;
}[] = [
  { delim: '**', contentCls: 'cm-atomic-strong', delimCls: 'cm-atomic-strong-mark' },
  { delim: '__', contentCls: 'cm-atomic-strong', delimCls: 'cm-atomic-strong-mark' },
  { delim: '~~', contentCls: 'cm-atomic-strike', delimCls: 'cm-atomic-strike-mark' },
  { delim: '*', contentCls: 'cm-atomic-em', delimCls: 'cm-atomic-em-mark' },
  { delim: '_', contentCls: 'cm-atomic-em', delimCls: 'cm-atomic-em-mark' },
];

function supplementMidTypingEmphasis(
  text: string,
  lineFrom: number,
  localCursor: number,
  out: Range<Decoration>[],
): void {
  // Track which characters of the line are already "owned" by a
  // matched delimiter pair so a single-char delimiter doesn't
  // accidentally pair halves of two different double-delimiter
  // spans.
  const consumed = new Uint8Array(text.length);

  for (const { delim, contentCls, delimCls } of MID_TYPING_DELIMITERS) {
    const dLen = delim.length;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const open = indexOfUnconsumed(text, delim, searchFrom, consumed);
      if (open < 0) break;
      const close = indexOfUnconsumed(text, delim, open + dLen, consumed);
      if (close < 0) break;

      for (let i = open; i < close + dLen; i++) consumed[i] = 1;

      const contentFrom = open + dLen;
      const contentTo = close;
      if (
        contentFrom < contentTo &&
        localCursor > open &&
        localCursor < close + dLen
      ) {
        out.push(
          Decoration.mark({ class: contentCls }).range(
            lineFrom + contentFrom,
            lineFrom + contentTo,
          ),
        );
        // Style the delimiter characters to match how lezer's
        // `EmphasisMark` tokens render when the pattern parses
        // cleanly. Lezer tags `EmphasisMark` with both its parent
        // (`strong` / `emphasis` / `strikethrough`) and
        // `processingInstruction`, so the `**` characters get
        // faint color AND the parent's weight / style / decoration
        // — we mirror all of that here so the delimiters don't
        // flip style / size / color when the cursor moves or a
        // trailing space triggers / untriggers lezer's parse.
        out.push(
          Decoration.mark({ class: delimCls }).range(
            lineFrom + open,
            lineFrom + contentFrom,
          ),
        );
        out.push(
          Decoration.mark({ class: delimCls }).range(
            lineFrom + contentTo,
            lineFrom + close + dLen,
          ),
        );
      }

      searchFrom = close + dLen;
    }
  }
}

function indexOfUnconsumed(
  text: string,
  needle: string,
  from: number,
  consumed: Uint8Array,
): number {
  let i = from;
  while (i <= text.length - needle.length) {
    const found = text.indexOf(needle, i);
    if (found < 0) return -1;
    let isConsumed = false;
    for (let k = found; k < found + needle.length; k++) {
      if (consumed[k]) {
        isConsumed = true;
        break;
      }
    }
    if (!isConsumed) return found;
    i = found + 1;
  }
  return -1;
}

const inlinePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildInlineDecorations(view);
    }

    update(update: ViewUpdate) {
      const prevFrozen = update.startState.field(previewFrozenField);
      const nextFrozen = update.state.field(previewFrozenField);
      const justUnfroze = prevFrozen && !nextFrozen;

      if (nextFrozen && !justUnfroze) return;

      // Note: `update.viewportChanged` is intentionally NOT in this
      // list. Scrolling alone must not rebuild decorations — doing
      // so on iOS halts momentum whenever the rebuild produces new
      // decorations for lines at the top of a scroll-up viewport
      // (CM6 anchor conflict with the scroll animation). Walking
      // the whole parsed tree on the remaining triggers means
      // scroll-time cost is zero; the tree walk itself is
      // single-digit ms for typical atoms.
      if (
        justUnfroze ||
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged
      ) {
        this.decorations = buildInlineDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// Tight-continuation Enter for bullet lists.
//
// Why we override the default: @codemirror/lang-markdown's
// `insertNewlineContinueMarkup` uses the syntax tree to decide whether a
// list is "loose" (blank lines between items) and, if so, inserts a
// blank line as part of the continuation. That inference bleeds in when
// you start a new list adjacent to an existing one — lezer sees both as
// siblings in a loose list, and the new item sprouts a blank line the
// user didn't intend. In our inline-preview mode loose vs tight lists
// look identical anyway, so we always continue tight.
function insertTightListItem(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const from = sel.from;
  const line = state.doc.lineAt(from);

  const tree = syntaxTree(state);
  let cursor = tree.resolveInner(from, -1).cursor();
  let inBulletList = false;
  for (;;) {
    if (cursor.name === 'BulletList') {
      inBulletList = true;
      break;
    }
    if (!cursor.parent()) break;
  }
  if (!inBulletList) return false;

  const lineText = state.doc.sliceString(line.from, line.to);
  const prefix = lineText.match(/^(\s*)([-*+])(\s+)/);
  if (!prefix) return false;

  const [whole, indent, marker] = prefix;
  const rest = lineText.slice(whole.length);

  const taskMatch = rest.match(/^(\[[ xX]\])(\s*)/);
  const taskPrefixLen = taskMatch ? taskMatch[0].length : 0;
  const contentAfterPrefix = rest.slice(taskPrefixLen);

  if (!contentAfterPrefix.trim()) {
    const depth = Math.floor(indent.length / 2);
    if (depth >= 1) {
      const outerIndent = indent.slice(0, indent.length - 2);
      const continuation = taskMatch ? `${marker} [ ] ` : `${marker} `;
      const replacement = `${outerIndent}${continuation}`;
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: replacement },
        selection: EditorSelection.cursor(line.from + replacement.length),
      });
    } else {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
      });
    }
    return true;
  }

  const continuation = taskMatch ? `${marker} [ ] ` : `${marker} `;
  const insert = `\n${indent}${continuation}`;
  view.dispatch({
    changes: { from, to: from, insert },
    selection: EditorSelection.cursor(from + insert.length),
  });
  return true;
}

function makeLinkClickHandler(onLinkClick: (url: string) => void): Extension {
  return EditorView.domEventHandlers({
    click: (event, view) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
      if (event.button !== 0) return false;
      const target = event.target;
      if (!(target instanceof Element)) return false;
      const linkEl = target.closest<HTMLElement>('.cm-atomic-link');
      if (!linkEl) return false;

      // Only fire on clicks within the trailing external-link icon,
      // not on the link text itself. The text stays editable
      // (click-to-place-caret); the icon is the explicit "open"
      // affordance. The icon is a `::after` pseudo-element so we
      // can't listen on it directly — compute its pixel bounds from
      // the link's last client rect (last, because wrapped links
      // only have the icon after the final visual line) and compare
      // against the click coordinates.
      const rects = Array.from(linkEl.getClientRects());
      if (rects.length === 0) return false;
      const lastRect = rects[rects.length - 1];
      const emSize = parseFloat(window.getComputedStyle(linkEl).fontSize);
      // Icon CSS: 0.78em width + 0.32em margin-left. Add a small hit
      // slop so touch / imprecise mouse clicks still land.
      const iconZone = emSize * 1.25;
      const onIcon =
        event.clientX >= lastRect.right - iconZone &&
        event.clientX <= lastRect.right &&
        event.clientY >= lastRect.top &&
        event.clientY <= lastRect.bottom;
      if (!onIcon) return false;

      const pos = view.posAtDOM(linkEl);
      if (pos < 0) return false;

      const tree = syntaxTree(view.state);
      let node: SyntaxNode | null = tree.resolveInner(pos, 1);
      while (node && node.name !== 'Link') node = node.parent;
      if (!node) return false;
      const urlNode = node.getChild('URL');
      if (!urlNode) return false;

      const url = view.state.doc.sliceString(urlNode.from, urlNode.to);
      if (!url) return false;

      event.preventDefault();
      event.stopPropagation();
      onLinkClick(url);
      return true;
    },
  });
}

/**
 * Assemble the inline-preview extension set. Call once per editor and
 * include the result in your EditorState `extensions` list. Accepts an
 * `onLinkClick` callback so consumers can route link opens through
 * their platform's external-URL mechanism (Tauri IPC, Capacitor
 * browser, etc.) instead of the default `window.open`.
 */
export function inlinePreview(config: InlinePreviewConfig = {}): Extension {
  const { onLinkClick = defaultOnLinkClick } = config;
  return [
    previewFrozenField,
    inlinePreviewPlugin,
    freezeMousePlugin,
    makeLinkClickHandler(onLinkClick),
    // Prec.highest to beat @codemirror/lang-markdown's own Enter
    // handler, which is registered internally by the `markdown()`
    // extension (not just via the exported markdownKeymap) and
    // otherwise wins precedence.
    Prec.highest(keymap.of([{ key: 'Enter', run: insertTightListItem }])),
  ];
}

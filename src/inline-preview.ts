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
    const span = document.createElement('span');
    span.className = 'cm-atomic-bullet';
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
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-atomic-task-checkbox';
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

  const tree = ensureSyntaxTree(state, view.viewport.to, 50) ?? syntaxTree(state);
  const viewportFrom = view.viewport.from;
  const viewportTo = view.viewport.to;

  const taskMarkerByLine = new Map<number, number>();
  tree.iterate({
    from: viewportFrom,
    to: viewportTo,
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
    from: viewportFrom,
    to: viewportTo,
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

      if (node.name === 'ListMark' && node.from < node.to) {
        const line = doc.lineAt(node.from);
        const lineNum = line.number;
        const taskFrom = taskMarkerByLine.get(lineNum);

        const rawIndent = node.from - line.from;
        if (rawIndent >= 2) {
          const depth = Math.floor(rawIndent / 2);
          ranges.push(
            Decoration.line({
              attributes: { style: `padding-left: ${depth * 0.6}em` },
            }).range(line.from),
          );
        }

        if (taskFrom !== undefined) {
          ranges.push(Decoration.replace({}).range(node.from, taskFrom));
        } else {
          const markText = doc.sliceString(node.from, node.to);
          if (markText === '-' || markText === '*' || markText === '+') {
            ranges.push(
              Decoration.replace({ widget: BULLET_WIDGET }).range(node.from, node.to),
            );
          }
        }
      }

      if (node.name === 'TableHeader' || node.name === 'TableRow') {
        const startLine = doc.lineAt(node.from);
        const endLine = doc.lineAt(node.to);
        for (let n = startLine.number; n <= endLine.number; n++) {
          const line = doc.line(n);
          ranges.push(Decoration.line({ class: 'cm-atomic-table-row' }).range(line.from));
          if (node.name === 'TableHeader') {
            ranges.push(
              Decoration.line({ class: 'cm-atomic-table-header' }).range(line.from),
            );
          }
        }
      }

      if (node.name === 'TableDelimiter' && node.from < node.to) {
        const lineNum = doc.lineAt(node.from).number;
        const isActive = activeLines.has(lineNum);
        if (node.to - node.from === 1) {
          if (!isActive) {
            ranges.push(Decoration.replace({}).range(node.from, node.to));
          }
        } else {
          const line = doc.lineAt(node.from);
          ranges.push(
            Decoration.line({ class: 'cm-atomic-table-divider' }).range(line.from),
          );
          if (!isActive) {
            ranges.push(Decoration.replace({}).range(node.from, node.to));
          }
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

  return Decoration.set(ranges, true);
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

      if (
        justUnfroze ||
        update.docChanged ||
        update.viewportChanged ||
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

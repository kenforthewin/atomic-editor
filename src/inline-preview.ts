import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type Text,
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
import { treeGrowthEffect, treeProgressPlugin } from './tree-progress';
import { readOnlyFacet } from './read-only';

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

function linkIconHitTarget(event: MouseEvent, root?: HTMLElement): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const linkEl = target.closest<HTMLElement>('.cm-atomic-link');
  if (!linkEl || (root && !root.contains(linkEl))) return null;

  // The icon is a `::after` pseudo-element, so it doesn't have its own
  // event target. Compute the same trailing hit-zone used by the click
  // opener and treat pointerdown in that zone as "on the icon", not
  // "inside editable link text".
  const rects = Array.from(linkEl.getClientRects());
  if (rects.length === 0) return null;
  const lastRect = rects[rects.length - 1];
  const emSize = parseFloat(window.getComputedStyle(linkEl).fontSize);
  const iconZone = emSize * 1.25;
  const onIcon =
    event.clientX >= lastRect.right - iconZone &&
    event.clientX <= lastRect.right &&
    event.clientY >= lastRect.top &&
    event.clientY <= lastRect.bottom;

  return onIcon ? linkEl : null;
}

// Whole-link hit test, used in read-only mode where the entire link
// (text + icon) is the open affordance. Mirrors `linkIconHitTarget`'s
// containment check but without the trailing-icon zone restriction.
function linkElementFromEvent(event: MouseEvent, root?: HTMLElement): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const linkEl = target.closest<HTMLElement>('.cm-atomic-link');
  if (!linkEl || (root && !root.contains(linkEl))) return null;
  return linkEl;
}

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
      // Read-only never reveals, so there's nothing to freeze. Bail
      // before any of the selection/icon plumbing runs.
      if (this.view.state.facet(readOnlyFacet)) return;
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
      if (linkIconHitTarget(event, this.view.contentDOM)) {
        // Let the follow-up click open the link, but stop CM6 from
        // interpreting the icon press as a text-editing click. Without
        // this, pointerdown moves the selection into the Link node and
        // reveals `[label](url)` before the click handler opens it.
        event.preventDefault();
        event.stopImmediatePropagation();
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
  'LinkTitle',
  'StrikethroughMark',
  'HighlightMark',
  'QuoteMark',
]);

// Children of a Link node whose visibility follows the link-scoped
// rule (cursor-inside-link) instead of the default line-based rule.
// The same token names can appear under an Image node — those stay
// on the line-based rule because images are a different UX surface.
const LINK_CHILD_SYNTAX = new Set(['LinkMark', 'URL', 'LinkTitle']);

const INLINE_MARK_CLASS: Record<string, string> = {
  StrongEmphasis: 'cm-atomic-strong',
  Emphasis: 'cm-atomic-em',
  InlineCode: 'cm-atomic-inline-code',
  Strikethrough: 'cm-atomic-strike',
  Highlight: 'cm-atomic-highlight',
  Link: 'cm-atomic-link',
};

// A Link can contain two URL nodes when its visible label is itself a
// URL: `[https://label](https://destination)`. Only the node after the
// closing `]` is the destination syntax that should collapse. Treating
// every URL under Link as a destination makes the visible label vanish.
function linkDestinationUrl(link: SyntaxNode, doc: Text): SyntaxNode | null {
  const labelClose = link
    .getChildren('LinkMark')
    .find((mark) => doc.sliceString(mark.from, mark.to) === ']');
  if (!labelClose) return null;
  return (
    link
      .getChildren('URL')
      .find((url) => url.from >= labelClose.to) ?? null
  );
}

// CommonMark matches reference labels after stripping the surrounding
// brackets, trimming, collapsing internal whitespace runs, and case
// folding.
function normalizeLinkLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

// The label a reference link resolves through: the explicit one in
// `[text][label]`, or the link text itself for the collapsed
// (`[text][]`) and shortcut (`[text]`) forms.
function linkReferenceLabel(link: SyntaxNode, doc: Text): string | null {
  const explicit = link.getChildren('LinkLabel')[0];
  if (explicit) {
    const inner = doc.sliceString(explicit.from + 1, explicit.to - 1);
    if (inner.trim() !== '') return normalizeLinkLabel(inner);
  }
  const marks = link.getChildren('LinkMark');
  const open = marks[0];
  const close = marks[1];
  if (!open || !close || open.to > close.from) return null;
  return normalizeLinkLabel(doc.sliceString(open.to, close.from));
}

// Lezer emits a `Link` node for every bracketed run that *could* be a
// link, including reference forms with no matching definition. Per
// CommonMark those are literal text: `[foo]` on its own renders as
// `[foo]`, brackets and all. Styling them as links (and hiding their
// brackets) makes ordinary prose — `see [note] below`, or a wiki link
// broken across a line — look like something clickable that isn't.
function linkResolves(
  link: SyntaxNode,
  doc: Text,
  definedLabels: Set<string>,
): boolean {
  // An inline link carries its own destination. The `(` test catches the
  // empty-destination form `[text]()`, which has no URL node.
  const inline = link
    .getChildren('LinkMark')
    .some((mark) => doc.sliceString(mark.from, mark.to) === '(');
  if (inline) return true;
  const label = linkReferenceLabel(link, doc);
  return label != null && definedLabels.has(label);
}

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

// ViewPlugin-sourced Decoration.replace ranges are forbidden from
// crossing a line break — CM6 throws "Decorations that replace line
// breaks may not be specified via plugins" at build time. Lezer
// happily emits tokens that do cross line breaks (a LinkTitle /
// Image title "wrapping across\ntwo lines", for instance), so every
// Decoration.replace we push has to be split into per-line segments
// first. The newline between segments stays visible — acceptable
// compromise, and it matches how other markdown editors render these
// uncommon multi-line forms.
function pushReplace(
  ranges: Range<Decoration>[],
  doc: Text,
  from: number,
  to: number,
  spec: Parameters<typeof Decoration.replace>[0] = {},
): void {
  if (from >= to) return;
  const startLine = doc.lineAt(from);
  if (to <= startLine.to) {
    ranges.push(Decoration.replace(spec).range(from, to));
    return;
  }
  // Multi-line: first segment carries the widget (if any) so it
  // renders in place of the opening token; subsequent segments are
  // plain hides. Emitting the widget on every segment would stack
  // duplicates (e.g. a BulletWidget on line 2+ of a wrapped item).
  let cursor = from;
  let firstSegment = true;
  while (cursor < to) {
    const line = doc.lineAt(cursor);
    const segEnd = Math.min(to, line.to);
    if (segEnd > cursor) {
      ranges.push(
        Decoration.replace(firstSegment ? spec : {}).range(cursor, segEnd),
      );
      firstSegment = false;
    }
    cursor = line.to + 1;
  }
}

const LIST_BASE_EM = 0.8;
const LIST_ALCOVE_EM = 1.2;
const LIST_LEVEL_EM = 0.6;

function nearestListItem(node: SyntaxNode | null): SyntaxNode | null {
  for (let current = node; current; current = current.parent) {
    if (current.name === 'ListItem') return current;
  }
  return null;
}

function listItemDepth(item: SyntaxNode): number {
  let depth = 0;
  for (let parent = item.parent; parent; parent = parent.parent) {
    if (parent.name === 'ListItem') depth++;
  }
  return depth;
}

function sameListItem(a: SyntaxNode | null, b: SyntaxNode): boolean {
  return a?.name === 'ListItem' && a.from === b.from && a.to === b.to;
}

function buildInlineDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const ranges: Range<Decoration>[] = [];

  // In read-only mode no line is ever "active" — the whole doc stays
  // rendered (no reveal). We skip the selection walk entirely rather
  // than relying on `hasFocus` staying false, so a programmatic
  // `.focus()` can't accidentally reveal source under reading mode.
  const readOnly = state.facet(readOnlyFacet);
  const activeLines = new Set<number>();
  if (view.hasFocus && !readOnly) {
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

  // `from` positions of Link nodes whose range overlaps a selection.
  // Link children (LinkMark/URL/LinkTitle) hide unless their parent
  // Link's `from` is in this set — i.e. the cursor has entered the
  // link specifically, not merely landed on the same line. Images
  // aren't included; they already have their own widget UX and the
  // line-based reveal is the right fit for `![alt](url)`.
  const activeLinkStarts = new Set<number>();

  // A link reference definition may sit anywhere in the document,
  // including after the link that uses it, so whether a `Link` node
  // resolves cannot be decided while the walk is passing it. Both the
  // link mark and the bracket-hiding for its children are collected
  // here and emitted once the walk has seen every definition.
  const definedLabels = new Set<string>();
  const pendingLinks: SyntaxNode[] = [];
  const pendingLinkSyntax: { from: number; to: number; linkFrom: number }[] =
    [];

  // Single pre-order walk. A tree walk visits a parent before its
  // children, which lets us compute two pieces of look-ahead state on
  // the way in — right before the children that depend on them:
  //   - Fenced-code active expansion: clicking any line of a fence
  //     activates the whole block. FencedCode is entered before its
  //     CodeMark/CodeInfo children, so expanding activeLines here means
  //     those children hide/reveal consistently with the block.
  //   - activeLinkStarts: a Link is entered before its LinkMark/URL/
  //     LinkTitle children, so recording it here makes the link-scoped
  //     reveal rule ready when those children are processed.
  // (A previous version ran a separate pre-pass plus a taskMarkerByLine
  // map. Folding both into this one walk halves the per-rebuild tree
  // traversal — meaningful because this runs on every cursor move and
  // its cost scales with document size.)
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
      }
      if (node.name === 'LinkReference') {
        const label = node.node.getChildren('LinkLabel')[0];
        if (label) {
          definedLabels.add(
            normalizeLinkLabel(doc.sliceString(label.from + 1, label.to - 1)),
          );
        }
      }
      if (node.name === 'Link' && view.hasFocus) {
        for (const range of state.selection.ranges) {
          // Inclusive overlap: cursor sitting exactly on either
          // boundary counts as inside, matching the UX where the
          // next keystroke affects the link.
          if (range.from <= node.to && range.to >= node.from) {
            activeLinkStarts.add(node.from);
            break;
          }
        }
      }
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
        if (node.name === 'Link') {
          pendingLinks.push(node.node);
        } else {
          ranges.push(
            Decoration.mark({ class: markClass }).range(node.from, node.to),
          );
        }
      }

      if (HIDEABLE_SYNTAX.has(node.name) && node.from < node.to) {
        const lineNum = doc.lineAt(node.from).number;

        // Link children use a link-scoped rule (cursor-inside-link)
        // rather than the line-based rule. A LinkMark under an
        // Image node falls through to line-based — images have
        // their own widget UX that the line-based reveal fits.
        let shouldHide: boolean;
        let linkParentFrom: number | undefined;
        if (LINK_CHILD_SYNTAX.has(node.name)) {
          let parent = node.node.parent;
          while (parent && parent.name !== 'Link' && parent.name !== 'Image') {
            parent = parent.parent;
          }
          if (parent && parent.name === 'Link') {
            linkParentFrom = parent.from;
            shouldHide = !activeLinkStarts.has(parent.from);
          } else {
            shouldHide = !activeLines.has(lineNum);
          }
        } else {
          shouldHide = !activeLines.has(lineNum);
        }

        if (shouldHide) {
          let hideTo = node.to;
          if (node.name === 'HeaderMark' || node.name === 'QuoteMark') {
            while (hideTo < doc.length && doc.sliceString(hideTo, hideTo + 1) === ' ') {
              hideTo++;
            }
          }
          if (linkParentFrom === undefined) {
            pushReplace(ranges, doc, node.from, hideTo);
          } else {
            // Brackets only collapse if the link turns out to resolve;
            // an unresolved reference keeps them, because they are the
            // literal text the document renders to.
            pendingLinkSyntax.push({
              from: node.from,
              to: hideTo,
              linkFrom: linkParentFrom,
            });
          }
        }
      }

      if (node.name === 'URL' && node.from < node.to) {
        const parent = node.node.parent;
        if (parent?.name === 'Link') {
          // A URL in the label is visible content. A URL after the
          // closing `]` is destination syntax and follows the existing
          // cursor-inside-this-link reveal rule—not whole-line activity.
          const destination = linkDestinationUrl(parent, doc);
          if (
            destination?.from === node.from &&
            !activeLinkStarts.has(parent.from)
          ) {
            pushReplace(ranges, doc, node.from, node.to);
          }
        } else {
          // Bare GFM URLs and `<https://...>` autolinks are visible
          // content, not syntax. Give them the same styling and icon
          // hit target as explicit links while leaving their text in
          // the document flow on inactive lines.
          ranges.push(
            Decoration.mark({ class: 'cm-atomic-link' }).range(
              node.from,
              node.to,
            ),
          );
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
          pushReplace(ranges, doc, node.from, node.from + 1);
        }
      }

      if (node.name === 'ListMark' && node.from < node.to) {
        const line = doc.lineAt(node.from);
        // Detect a task item from the line text. ListMark is visited
        // before the TaskMarker on its line, so a forward single-pass
        // walk can't look the marker position up from a map; the
        // capture group is the `- ` lead-in and its length lands
        // taskFrom exactly on the `[` (matching TaskMarker.from).
        const taskLead = line.text.match(/^(\s*[-*+]\s+)\[[ xX]\]/);
        const taskFrom =
          taskLead != null ? line.from + taskLead[1].length : undefined;

        // Hanging-indent every physical line owned by this list item.
        // Ownership and depth come from the parsed tree, not raw source
        // indentation: CommonMark allows up to three leading spaces on a
        // top-level item, and ordered-list children commonly use a
        // marker-width indent rather than two spaces.
        //
        // Layout:
        //
        //   <--BASE--><--ALCOVE--> first-line text
        //             •            wrapped lines land at the
        //                          same column as the first-line
        //                          text, not back under the marker
        //
        // LIST_ALCOVE_EM is fixed regardless of list kind.
        // Every marker (bullet widget, checkbox widget, ordered
        // number via mark decoration) is forced into an
        // inline-block of exactly that width via CSS — so the
        // alignment math doesn't depend on per-font marker
        // widths. `padding-left` sets the content column;
        // negative `text-indent` of the same magnitude pulls the
        // first line back so the marker lands in the alcove. Structural
        // leading spaces are replaced visually on every owned line;
        // otherwise they would be added on top of the tree-derived
        // padding and ordered/odd indentation would still drift.
        const listItem = nearestListItem(node.node);
        if (listItem) {
          const depth = listItemDepth(listItem);
          const padding =
            LIST_BASE_EM + LIST_ALCOVE_EM + depth * LIST_LEVEL_EM;
          const firstLine = doc.lineAt(listItem.from);
          const lastLine = doc.lineAt(listItem.to);

          for (
            let number = firstLine.number;
            number <= lastLine.number;
            number++
          ) {
            const ownedLine = doc.line(number);
            const contentOffset = ownedLine.text.search(/\S/);
            if (contentOffset < 0) continue;
            const contentFrom = ownedLine.from + contentOffset;
            const owner = nearestListItem(tree.resolve(contentFrom, 1));
            if (!sameListItem(owner, listItem)) continue;

            const markerLine = ownedLine.number === line.number;
            ranges.push(
              Decoration.line({
                attributes: {
                  style: `padding-left: ${padding}em; text-indent: ${
                    markerLine ? `-${LIST_ALCOVE_EM}` : '0'
                  }em`,
                },
              }).range(ownedLine.from),
            );
            if (contentFrom > ownedLine.from) {
              pushReplace(ranges, doc, ownedLine.from, contentFrom);
            }
          }
        }

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
          pushReplace(ranges, doc, node.from, taskFrom);
        } else {
          const markText = doc.sliceString(node.from, node.to);
          if (markText === '-' || markText === '*' || markText === '+') {
            // Bullet: substitute with the fixed-width marker
            // widget, swallowing the trailing space so content
            // starts precisely at padding-left.
            pushReplace(ranges, doc, node.from, markEnd, { widget: BULLET_WIDGET });
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
              pushReplace(ranges, doc, node.to, markEnd);
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
          pushReplace(ranges, doc, line.from, line.to);
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
          pushReplace(ranges, doc, node.from, node.to);
        }
      }

      if (node.name === 'TaskMarker' && node.from < node.to) {
        const markText = doc.sliceString(node.from, node.to);
        const checked = /\[x\]/i.test(markText);
        // Swallow the single trailing space after `[ ]` / `[x]` so the
        // checkbox widget owns the alcove exactly (mirrors how bullet
        // markers also swallow their trailing space). Without this the
        // space stays visible, pushing first-line content to the right
        // of where wrapped lines start — visible as a 0.3em hang.
        const hasTrailingSpace =
          node.to < doc.length &&
          doc.sliceString(node.to, node.to + 1) === ' ';
        const replaceTo = hasTrailingSpace ? node.to + 1 : node.to;
        pushReplace(ranges, doc, node.from, replaceTo, {
          widget: new TaskCheckboxWidget(checked),
        });
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

  // Every definition has now been seen, so the deferred link work can
  // be decided. Unresolved references get neither the link mark nor
  // the bracket collapse: they stay the literal text they render to.
  const resolvedLinkStarts = new Set<number>();
  for (const link of pendingLinks) {
    if (!linkResolves(link, doc, definedLabels)) continue;
    resolvedLinkStarts.add(link.from);
    ranges.push(
      Decoration.mark({ class: 'cm-atomic-link' }).range(link.from, link.to),
    );
  }
  for (const syntax of pendingLinkSyntax) {
    if (!resolvedLinkStarts.has(syntax.linkFrom)) continue;
    pushReplace(ranges, doc, syntax.from, syntax.to);
  }

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
  { delim: '==', contentCls: 'cm-atomic-highlight', delimCls: 'cm-atomic-highlight-mark' },
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
    // Underscore emphasis (`_`, `__`) doesn't open intra-word under
    // CommonMark's flanking rules — `snake_case_var` is not italic.
    // Without this guard the supplement would flash false italic while
    // the cursor sits between two intra-word underscores (exactly the
    // flicker this feature exists to prevent, inverted). Asterisk
    // delimiters have no such restriction, so only gate underscores.
    const isUnderscore = delim === '_' || delim === '__';
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const open = indexOfUnconsumed(text, delim, searchFrom, consumed);
      if (open < 0) break;
      if (isUnderscore && open > 0 && /\w/.test(text[open - 1])) {
        searchFrom = open + dLen;
        continue;
      }
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

      // A doc change is unambiguous edit intent, so rebuild even while
      // frozen. Returning the stale (pre-edit) decoration set here would
      // hand CM6 ranges whose positions no longer match the document: a
      // hidden `## ` replace can end up spanning the newly-typed text's
      // line break ("Decorations that replace line breaks may not be
      // specified via plugins"), and the stale positions corrupt the
      // heightmap ("No tile at position …" → broken scrollIntoView). The
      // freeze only needs to suppress the *selection*-driven reveal that
      // makes a click jitter; typing should reveal syntax as normal.
      if (nextFrozen && !justUnfroze && !update.docChanged) return;

      // Tree-growth effect: background parser advanced past where
      // we last walked. For docs large enough that the initial
      // parse didn't reach the end, later blocks (headings, lists,
      // etc.) render as raw `##`/`**` until this fires.
      let treeGrew = false;
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(treeGrowthEffect)) {
            treeGrew = true;
            break;
          }
        }
        if (treeGrew) break;
      }

      // Note: `update.viewportChanged` is intentionally NOT in this
      // list. Scrolling alone must not rebuild decorations — doing
      // so on iOS halts momentum whenever the rebuild produces new
      // decorations for lines at the top of a scroll-up viewport
      // (CM6 anchor conflict with the scroll animation). Walking
      // the whole parsed tree on the remaining triggers means
      // scroll-time cost is zero; the tree walk itself is
      // single-digit ms for typical atoms.
      // A read-only toggle (compartment reconfigure) changes neither
      // doc nor selection nor focus, so detect the facet flip directly
      // — otherwise reading mode wouldn't repaint into / out of the
      // fully-rendered state.
      const readOnlyChanged =
        update.startState.facet(readOnlyFacet) !==
        update.state.facet(readOnlyFacet);

      if (
        justUnfroze ||
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        treeGrew ||
        readOnlyChanged
      ) {
        this.decorations = buildInlineDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// CM6's drawSelection layer intentionally sits behind `.cm-content`. That is
// normally ideal—the rectangle is behind the glyphs—but an opaque fenced-code
// line background also sits between the layer and the glyphs, hiding the
// selection completely. Mirror only the selected portions of FencedCode as
// inline marks so their background paints above the block and below its text.
// This plugin stays separate from inlinePreviewPlugin because mouse selection
// must repaint live even while preview decorations are frozen for click-jitter
// prevention.
function fencedCodeSelectionDecorations(view: EditorView): DecorationSet {
  const selections = view.state.selection.ranges.filter((range) => !range.empty);
  if (selections.length === 0) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);
  for (const selection of selections) {
    // Selection updates can arrive for every pointermove. Restrict the walk to
    // the selected range so dragging within a short code sample stays O(range)
    // instead of walking an entire long document on every event.
    tree.iterate({
      from: selection.from,
      to: selection.to,
      enter(node) {
        if (node.name !== 'FencedCode') return;
        const from = Math.max(node.from, selection.from);
        const to = Math.min(node.to, selection.to);
        if (from < to) {
          ranges.push(
            Decoration.mark({ class: 'cm-atomic-fenced-selection' }).range(from, to),
          );
        }
        return false;
      },
    });
  }
  return Decoration.set(ranges, true);
}

const fencedCodeSelectionPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = fencedCodeSelectionDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = fencedCodeSelectionDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
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
      // In read-only mode there's no editable link text to protect, so
      // a click anywhere on the link opens it. In edit mode the open
      // affordance stays scoped to the trailing icon hit-zone so the
      // text itself remains clickable-to-edit.
      const linkEl = view.state.facet(readOnlyFacet)
        ? linkElementFromEvent(event, view.contentDOM)
        : linkIconHitTarget(event, view.contentDOM);
      if (!linkEl) return false;

      const pos = view.posAtDOM(linkEl);
      if (pos < 0) return false;

      const tree = syntaxTree(view.state);
      let node: SyntaxNode | null = tree.resolveInner(pos, 1);
      let visibleUrl: SyntaxNode | null = null;
      while (node && node.name !== 'Link') {
        if (node.name === 'URL') visibleUrl = node;
        node = node.parent;
      }
      const urlNode = node
        ? linkDestinationUrl(node, view.state.doc)
        : visibleUrl;
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
    fencedCodeSelectionPlugin,
    freezeMousePlugin,
    treeProgressPlugin,
    makeLinkClickHandler(onLinkClick),
    // Prec.highest to beat @codemirror/lang-markdown's own Enter
    // handler, which is registered internally by the `markdown()`
    // extension (not just via the exported markdownKeymap) and
    // otherwise wins precedence.
    Prec.highest(keymap.of([{ key: 'Enter', run: insertTightListItem }])),
  ];
}

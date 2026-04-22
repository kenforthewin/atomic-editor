import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
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
  type DecorationSet,
} from '@codemirror/view';

// Image blocks.
//
// When a markdown image (`![alt](url)`) appears in the doc, we render
// the actual image as a block-level widget immediately below the line
// that contains its source. This follows Obsidian's model: the
// markdown text and the rendered image coexist, with the markdown
// visible only when its line is active (cursor on the line).
//
// Block widgets can't come from a ViewPlugin (CM6 requires them to
// originate from a StateField or a mandatory facet), so this lives
// in its own StateField alongside the ViewPlugin-based inline
// decorations. The two compose naturally — CM6 layers their
// decoration sets at render time.
//
// Scope: we emit one image widget per Image node. Images inside
// otherwise-text paragraphs still get a widget below the paragraph;
// it's visually slightly awkward but matches the "always render
// the image" invariant. Most markdown in practice has images on
// their own line, where this looks right.

// Session-lifetime cache of observed natural image dimensions, keyed
// by URL. CM6's virtualizer unmounts line DOM when it leaves the
// viewport and calls `toDOM` again on the way back. Without a
// cache, the `<img>` starts with no intrinsic size on each remount,
// lays out as a zero-height box, measures, then snaps to its real
// size once decode completes — and the heightmap grows under the
// scroll animation. On iOS that reads as an anchor conflict and
// halts kinetic scroll, but only in the direction where the growth
// opposes the scroll (e.g. scrolling up past a remounting image
// that just grew taller pushes content down against the motion).
// Setting `width` and `height` attrs from this cache pins the
// aspect ratio on mount, so there's no grow-after-mount event.
const dimensionCache = new Map<string, { w: number; h: number }>();

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-atomic-image';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    // Set intrinsic dims from the cache so the widget reserves the
    // right box before the image decodes — prevents the remount +
    // resize cycle that halts iOS momentum scroll. On first-ever
    // mount the cache is cold; the `load` listener below records
    // the natural dims so subsequent remounts come up pre-sized.
    // CSS (`max-width: 100%; height: auto` on the img) still lets
    // the browser scale the attributes to the content column.
    const cached = dimensionCache.get(this.src);
    if (cached) {
      img.width = cached.w;
      img.height = cached.h;
    } else {
      img.addEventListener('load', () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          dimensionCache.set(this.src, {
            w: img.naturalWidth,
            h: img.naturalHeight,
          });
        }
      });
    }
    wrap.appendChild(img);

    // Clicking the image should land the caret on the source line
    // (where the `![alt](url)` markdown lives) so the reveal happens
    // and the user can edit. CM6's default behavior for block widgets
    // places the caret at the nearest edge, which for a side:1 widget
    // is the START of the NEXT line — not the source line. We compute
    // the widget's doc position via posAtDOM, step back into the
    // preceding line (the source), and dispatch an explicit selection.
    const onPointer = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const pos = view.posAtDOM(wrap);
      if (pos < 0) return;
      const target = Math.max(0, pos - 1);
      view.focus();
      view.dispatch({
        selection: { anchor: target },
        scrollIntoView: false,
      });
    };
    wrap.addEventListener('mousedown', onPointer);
    return wrap;
  }

  // Block CM6's own mouse handling so our listener above is the sole
  // thing deciding where the caret goes.
  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

function buildImageBlocks(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // Push the parser to cover the whole doc so image nodes in
  // regions CM6 hasn't yet parsed get widgetized. Without this, for
  // moderately long atoms the initial parse doesn't reach the
  // bottom and images past the initial parse window render as raw
  // `![alt](url)` text forever — the StateField only rebuilds on
  // doc change, not on parser advance. 200ms is a generous
  // upper bound; typical atoms finish in well under 10ms.
  const tree =
    ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Image') return;
      // Skip Images inside tables — the table widget renders them
      // as inline `<img>` elements in their cells. Emitting a
      // block widget below the table row would double-render and
      // the source it points at is hidden behind the table's
      // block-replace anyway.
      for (let p = node.node.parent; p; p = p.parent) {
        if (p.name === 'Table') return;
      }
      // Slice the whole image source and regex out src / alt. This
      // handles the common shapes — `![alt](url)` and
      // `![alt](url "title")` — without us walking the lezer tree
      // for each piece. We don't go to heroic lengths on edge cases
      // (escaped parens etc.); the regex fails safely by skipping
      // the widget.
      const raw = state.doc.sliceString(node.from, node.to);
      const match = raw.match(/^!\[([^\]]*)\]\(([^\s)"']+)(?:\s+["'][^)]*["'])?\)$/);
      if (!match) return;
      const [, alt, src] = match;
      if (!src) return;

      const line = state.doc.lineAt(node.from);
      ranges.push(
        Decoration.widget({
          widget: new ImageWidget(src, alt),
          block: true,
          // side: 1 places the block widget after the line's content,
          // so the image appears below its source line.
          side: 1,
        }).range(line.to),
      );
    },
  });

  return Decoration.set(ranges, true);
}

// Detect whether a doc change could have added, removed, or modified
// an Image node. Two cheap signals:
//
//   1. Any existing image decoration overlaps the changed range. That
//      covers edits to (or deletions of) an image already in the doc.
//   2. Any line touched by the change now contains the `![` marker.
//      That catches new images being typed AND edits that complete a
//      partially-typed image on an existing line.
//
// If neither signal fires, the change can't affect image widgets and
// we can skip `buildImageBlocks` entirely — `deco.map(tr.changes)`
// shifts existing decoration positions to the post-change doc, which
// is what we want for an unaffected edit. Turns per-keystroke cost
// from O(doc) to O(change size) on plain-prose edits of large atoms.
function changeAffectsImages(tr: Transaction, existing: DecorationSet): boolean {
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
      if (state.doc.line(n).text.includes('![')) {
        affected = true;
        break;
      }
    }
  });
  return affected;
}

const imageBlocksField = StateField.define<DecorationSet>({
  create: (state) => buildImageBlocks(state),
  update(deco, tr) {
    // Selection and viewport changes don't affect the widget set
    // (though they do affect whether the surrounding markdown is
    // shown, which is handled by the inline-preview ViewPlugin).
    if (!tr.docChanged) return deco;
    // Most keystrokes on a large atom are in plain prose with no
    // image nearby. Map existing decorations through the change and
    // skip the full-doc walk unless the change actually touches an
    // image.
    const mapped = deco.map(tr.changes);
    if (!changeAffectsImages(tr, deco)) return mapped;
    return buildImageBlocks(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function imageBlocks(): Extension {
  return imageBlocksField;
}

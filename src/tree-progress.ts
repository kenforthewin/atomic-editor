import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

// Broadcasts that lezer's incremental parser has advanced past where
// it was last observed. Consumers (tables, images, inline-preview)
// watch for this effect and rebuild their decorations so content
// parsed into existence during idle time actually renders.
//
// Needed because:
//  - Our StateField builders call `ensureSyntaxTree(state, docLen,
//    budget)` with a small budget (200ms) to avoid blocking the
//    initial render. For documents large enough to exceed the
//    budget, the tree covers only a prefix of the doc at mount.
//  - StateFields only recompute on transactions. Without a transaction
//    carrying a signal, the background parser can advance all it
//    wants and the decorations never catch up — late tables and
//    images stay as raw `| col |` / `![…](…)` text forever.
//  - The inline-preview ViewPlugin has the same shape: it walks a
//    possibly-partial tree and caches the result.
export const treeGrowthEffect = StateEffect.define<null>();

// How much must the parsed range grow before we dispatch a rebuild
// effect. A too-small threshold means a storm of tiny rebuilds while
// the parser chews through the doc; too large means the user might
// scroll past an unparsed region before it catches up. 8KB is roughly
// two viewport-heights of text and reliably contains several table/
// image blocks in our sample content.
const GROWTH_THRESHOLD = 8192;

// Budget per idle tick — short enough to keep the main thread
// responsive, long enough to make real progress. rIC/rAF fire at
// 16ms+, so 30ms is "push a bit past one frame" rather than "steal a
// whole frame."
const TICK_BUDGET_MS = 30;

type IdleHandle = { kind: 'idle'; id: number } | { kind: 'raf'; id: number };

function scheduleIdle(cb: () => void): IdleHandle {
  if (typeof window.requestIdleCallback === 'function') {
    return { kind: 'idle', id: window.requestIdleCallback(() => cb()) };
  }
  return { kind: 'raf', id: window.requestAnimationFrame(() => cb()) };
}

function cancelIdle(handle: IdleHandle): void {
  if (handle.kind === 'idle' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle.id);
  } else if (handle.kind === 'raf') {
    window.cancelAnimationFrame(handle.id);
  }
}

/**
 * View plugin that monitors lezer's parse progress and dispatches a
 * `treeGrowthEffect` whenever the tree has grown enough that
 * downstream decoration builders should re-run. Include this in your
 * extension set alongside the state fields that depend on tree
 * coverage — it's a no-op for small docs where the initial parse
 * already covers everything.
 */
// TS caveat: ViewPlugin.fromClass takes an anonymous class, and
// tsc's declaration emit (for the exported plugin constant) rejects
// `private` / `protected` / `readonly` modifiers on its members
// ("property may not be private or protected on an exported
// anonymous class type"). Underscore prefix keeps the "don't touch"
// convention without tripping that check.
export const treeProgressPlugin = ViewPlugin.fromClass(
  class {
    view: EditorView;
    _lastTreeLen: number;
    _idleHandle: IdleHandle | null = null;
    _destroyed = false;

    constructor(view: EditorView) {
      this.view = view;
      this._lastTreeLen = syntaxTree(view.state).length;
      this._schedule();
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        // Doc edits invalidate everything we knew about tree length;
        // lezer re-parses from the edit point. Reset and kick the
        // loop so new content gets picked up.
        this._lastTreeLen = syntaxTree(update.state).length;
        this._schedule();
      }
    }

    destroy() {
      this._destroyed = true;
      if (this._idleHandle !== null) {
        cancelIdle(this._idleHandle);
        this._idleHandle = null;
      }
    }

    _schedule() {
      if (this._idleHandle !== null) return;
      this._idleHandle = scheduleIdle(() => {
        this._idleHandle = null;
        if (!this._destroyed) this._tick();
      });
    }

    _tick() {
      const state = this.view.state;
      const docLen = state.doc.length;
      if (this._lastTreeLen >= docLen) return;

      // Push the parser further. `ensureSyntaxTree` returns null if
      // the budget expires before reaching the target — in that case
      // we still want to read whatever progress was made.
      const ensured = ensureSyntaxTree(state, docLen, TICK_BUDGET_MS);
      const newLen = (ensured ?? syntaxTree(state)).length;

      if (newLen >= this._lastTreeLen + GROWTH_THRESHOLD || newLen >= docLen) {
        const previous = this._lastTreeLen;
        this._lastTreeLen = newLen;
        try {
          this.view.dispatch({ effects: treeGrowthEffect.of(null) });
        } catch {
          // View destroyed mid-flight; revert the baseline so a
          // subsequent tick (if any) still has something to report.
          this._lastTreeLen = previous;
          return;
        }
      }

      if (newLen < docLen) this._schedule();
    }
  },
);

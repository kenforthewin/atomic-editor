import { Prec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// Obsidian-style extension of emphasis pairs.
//
// Problem: CM6's built-in `closeBrackets()` handles single-char pairs
// well (type `*`, get `*|*`). Typing a second `*` with the cursor
// between them is treated as "step through the closer" and produces
// `**|` — which means writing bold (`**foo**`) is a 5-keystroke dance
// (star, star-step, content, star-new-pair, star-step).
//
// This handler fires when the user types `*` (or `_`) with the cursor
// sitting exactly between two matching characters — an empty pair
// that closeBrackets just inserted. Instead of stepping through, we
// extend the pair: `*|*` becomes `**|**`, ready for bold content. All
// other cases fall through to closeBrackets.
//
// Runs at Prec.high so it beats closeBrackets' input handler when
// both want to act on the keystroke.
export const extendEmphasisPair = Prec.high(
  EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '*' && text !== '_') return false;
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty || from !== to) return false;

    const before = state.doc.sliceString(Math.max(0, from - 1), from);
    const after = state.doc.sliceString(
      from,
      Math.min(state.doc.length, from + 1),
    );
    if (before !== text || after !== text) return false;

    view.dispatch({
      changes: { from, insert: text + text },
      selection: { anchor: from + 1 },
    });
    return true;
  }),
);

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

// Auto-close markdown code fences.
//
// When the user completes an opening fence at the start of a line:
//
//   ```|
//
// immediately insert the matching closing fence below:
//
//   ```|
//   ```
//
// The cursor deliberately stays after the opening marker, not inside
// the block, so the user can still type an info string (`ts`, `rust`,
// etc.) and then press Enter into the fenced body. If the cursor is
// already inside an open fenced block, we do nothing — in that context
// typing ``` is likely the user's manual closing fence.
export const autoCloseCodeFence = Prec.highest(
  EditorView.inputHandler.of(autoCloseCodeFenceInput),
);

export function autoCloseCodeFenceInput(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean {
  if (text !== '`' || from !== to) return false;

  const { state } = view;
  const line = state.doc.lineAt(from);
  const before = state.doc.sliceString(line.from, from);
  const after = state.doc.sliceString(from, line.to);
  const match = before.match(/^(\s{0,3})``$/);
  if (!match) return false;
  if (after !== '' && after !== '`') return false;
  if (isInsideFencedCodeBeforeLine(state.doc.toString(), line.number)) return false;

  const indent = match[1];
  const replaceTo = after === '`' ? from + 1 : from;
  const insert = '`\n' + indent + '```';
  view.dispatch({
    changes: { from, to: replaceTo, insert },
    selection: { anchor: from + 1 },
  });
  return true;
}

function isInsideFencedCodeBeforeLine(doc: string, lineNumber: number): boolean {
  const lines = doc.split('\n');
  let marker: '`' | '~' | null = null;
  let markerLength = 0;

  for (let i = 0; i < lineNumber - 1; i++) {
    const match = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) continue;

    const currentMarker = match[1][0] as '`' | '~';
    const currentLength = match[1].length;
    if (!marker) {
      marker = currentMarker;
      markerLength = currentLength;
    } else if (currentMarker === marker && currentLength >= markerLength) {
      marker = null;
      markerLength = 0;
    }
  }

  return marker !== null;
}

# Architecture

This document covers the design philosophy and implementation details
of `@atomic-editor/editor`. It's not an inventory of every function —
it's the set of decisions worth holding in your head before changing
anything, because the surface area is small but each piece is
load-bearing.

## Why CodeMirror 6

Most WYSIWYG markdown editors are built on ProseMirror (Milkdown,
Tiptap, etc.). They produce polished editing surfaces but can't
virtualize — ProseMirror's state model requires the entire document
tree in memory and mounted as DOM on every render. For long documents
that's a non-starter: open time grows linearly with size, scrolling
jitters under layout churn, memory pressure becomes real, and iOS
kinetic scroll halts on big height changes.

CodeMirror 6 virtualizes natively. It renders only the viewport, the
parser (`@lezer/markdown`) is incremental, and the whole system is
built around decorations that compose cleanly. The tradeoff is that
CM6 is a text editor at heart — "WYSIWYG" in CM6 means carefully
choreographed decorations layered over a raw text buffer, not a rich-
content model like ProseMirror's.

## Core invariant 1: raw markdown is the source of truth

**The document text in `state.doc` is always plain markdown.** Every
decoration is view-only. This is the single rule the whole design
follows from, and it's worth stating twice:

- What you see on screen may differ from the raw text (hidden syntax
  tokens, rendered bullet characters, checkbox widgets, rendered
  images, WYSIWYG tables, etc.).
- What you copy, what gets saved, what another editor would parse is
  always the underlying markdown.

This invariant is why cross-block selection "just works" — the browser
selection maps to doc positions, and copy reads raw markdown from those
positions. It's why collaborative editing and diffing can be bolted on
without rethinking the view layer. And it's why what the user sees
matches what's persisted.

## Core invariant 2: no layout shifts

An earlier iteration briefly shipped a "block" preview mode that
replaced each block with a rendered HTML widget. Every cursor move
between blocks caused a height change as the clicked block unfolded to
raw and the leaving block refolded. Measured at ~0.1 CLS per 10 cursor
moves; in practice it felt like the UI was vibrating under the user.

The current mode ("inline live preview") avoids layout shifts by
making line heights depend **only on CSS class**, not on whether
syntax tokens are visible. A heading line styled `.cm-atomic-h1` is
~1.35em whether the `# ` prefix is currently hidden or revealed.
Active / inactive states toggle token visibility via
`Decoration.replace({})`, which removes characters from flow without
changing the enclosing line's measured height.

Measured CLS for the same 10 cursor-moves test in inline mode: ~0.003
— essentially all of it is the cursor caret redrawing. The structure
doesn't shift.

## File layout

```
src/
  index.ts               public API (AtomicCodeMirrorEditor + types)
  AtomicCodeMirrorEditor.tsx   React shell + imperative handle
  inline-preview.ts      main decoration engine (ViewPlugin)
  image-blocks.ts        block image widgets (StateField)
  table-widget.ts        WYSIWYG tables (StateField)
  edit-helpers.ts        bracket / emphasis auto-pairing
  atomic-theme.ts        theme + syntax highlighting
  code-languages.ts      curated fenced-code grammar registry
  styles/inline-preview.css   all editor CSS in one file
```

Every CodeMirror module is a **peer dependency** so the consumer's
bundler resolves a single copy. Two copies of `@codemirror/state` in
the same bundle silently break state-field identity checks; peer-deps
are what prevent that.

## `AtomicCodeMirrorEditor`

A React wrapper around a single `EditorView`. Teardown on unmount;
document identity (`documentId ?? markdownSource`) keys the view so
cursor / undo state from one document can't bleed into the next.

The component exposes an imperative handle via `editorHandleRef`:
`focus`, `undo`, `redo`, `openSearch(query?)`, `closeSearch`,
`isSearchOpen`, `getMarkdown`, `getContentDOM`.

Notable props:

- `markdownSource` — initial content; the editor owns the doc after
  mount.
- `onMarkdownChange` — fires for every doc mutation, including
  internal ones (checkbox toggles, tight-list continuations).
- `initialSearchText` — opens the search panel pre-filled, useful for
  landing users on a search hit.
- `onLinkClick` — called when the user taps the external-link icon
  rendered next to a link. Defaults to `window.open`; override for
  platform-specific shells (Tauri, Capacitor, Electron).
- `codeLanguages` — grammars for fenced code blocks; defaults to
  `[]`. See the README for usage.

## `inline-preview.ts` — the decoration engine

Three pieces, each with a specific reason to exist.

### `previewFrozenField`

A boolean `StateField` tracking whether decoration rebuilds are
paused. Toggled via a `setFrozen` effect from the freeze plugin.

### `freezeMousePlugin`

A `ViewPlugin` with a **capture-phase** `pointerdown` listener on
`view.dom` and a `pointerup` listener on `window`. On pointerdown
inside the content DOM, it dispatches `setFrozen(true)`. On pointerup,
after a ~100ms tail, it dispatches `setFrozen(false)`.

The freeze exists because clicking a heading used to reveal its `# `
prefix immediately — which shifted the heading text rightward under
the user's cursor mid-click, sometimes promoting the click into a
micro-drag selection. Now the reveal waits until the click has fully
resolved.

**Capture-phase matters**: `@codemirror/lang-markdown`'s own
pointerdown handler runs bubble-phase and dispatches selection
changes. Without capture, CM6 can rebuild decorations before we
freeze, and the reveal fires anyway. **The content-DOM filter matters
too**: without it, a scrollbar drag engages the freeze and stops
decoration rebuilds for the whole drag — deep content stays raw until
mouseup.

### `inlinePreviewPlugin`

A `ViewPlugin` whose `decorations` facet drives the display. Rebuilds
on doc change, selection change, or focus change, subject to the
freeze flag. **Not on viewport change** — scrolling alone must not
rebuild decorations, because on iOS that halts kinetic momentum
whenever the rebuild produces new decorations for lines at the top of
a scroll-up viewport (CM6 anchor conflict with the scroll animation).

The build function calls `ensureSyntaxTree(state, state.doc.length,
200)` to force full-doc parser coverage before walking the tree. A
partial parse means content past the initial parse window renders as
raw `##`/`**` forever, since decorations don't rebuild on scroll
anymore. Full coverage is a one-shot cost; subsequent calls are near-
free because `ensureSyntaxTree` short-circuits once the tree reaches
the target.

## What gets hidden, styled, or replaced

- **Line classes** (applied unconditionally based on block type):
  `cm-atomic-h1`..`h6`, `cm-atomic-blockquote`,
  `cm-atomic-fenced-code`, `cm-atomic-hr`, `cm-atomic-task-done`.
  These set font size / weight / decoration. No height changes between
  active and inactive states because the class doesn't care about
  cursor position.

- **Inline content marks** (applied unconditionally to content between
  syntax tokens): `cm-atomic-strong`, `cm-atomic-em`,
  `cm-atomic-inline-code`, `cm-atomic-strike`, `cm-atomic-link`. The
  link mark also renders an "open externally" icon via a `::after`
  pseudo-element; only the icon's hit region is clickable, since the
  link text itself is editable prose.

- **Hide decorations** (applied only on inactive lines): `HeaderMark`,
  `EmphasisMark`, `CodeMark`, `CodeInfo`, `LinkMark`, `URL`,
  `LinkTitle`, `StrikethroughMark`, `QuoteMark`, and `Escape`. Header
  and quote marks swallow a trailing space so the hidden-state line
  doesn't read indented. `Escape` hides only the leading backslash —
  content ingested from RSS or other sources full of `\.` and `\,`
  reads clean until focused.

- **Widgets** (always-on replacements): `•` for bullet `ListMark`, a
  checkbox for `TaskMarker`, horizontal-rule rendering via a CSS
  `::after` rule on the line, rendered images below each image source
  line (see `image-blocks.ts`), and full WYSIWYG tables (see
  `table-widget.ts`).

## `image-blocks.ts` — block image widgets

Images can't be emitted from a `ViewPlugin` because CM6 requires block
decorations to come from a `StateField` or a mandatory facet. The
image state field lives alongside the inline preview plugin; CM6
composes the two decoration sets at render time.

For each `Image` node, the field emits a block widget with `side: 1`
at `line.to`, so the image renders immediately below its source line.
Images inside tables are skipped — the table widget renders them
inline in the cells.

Size invariants: the `<img>` uses `display: block; max-width: 100%;
height: auto` so it fits the reading column without upscaling beyond
natural size. Small images render at their own size, left-aligned.

**Narrow invalidation**: on every transaction, `changeAffectsImages`
checks whether the change overlaps an existing image decoration OR
whether the changed lines contain `![`. If neither, the state field
returns its mapped-through existing set unchanged. This keeps editing
cost O(change size), not O(doc size), for plain-prose edits on large
documents.

## `table-widget.ts` — WYSIWYG tables

Tables give up on the "source-as-DOM" invariant at the row level: a
Table node's entire range is replaced with an interactive `<table>`
widget. Each cell is a small DOM tree owning a contenteditable
`<div>` holding the raw markdown and, when the cell contains
`![alt](url)`, a preview strip rendering the image below.

The widget's `eq()` is structure-only (row × column count), so CM6
keeps the existing DOM across per-keystroke dispatches and the caret
survives edits. Cell input re-serializes the whole table and replaces
the current source range — the range is resolved fresh via `posAtDOM
+ tree walk` every time, because earlier edits shift the bounds.

Wide tables get their own horizontal scroll inside a wrapper
(`overflow-x: auto`), so the editor's content column isn't forced
wider than the viewport when a 10-column table enters view. This was
the root cause of a mobile overflow bug and is worth preserving.

Interaction contract:

- Tab / Shift-Tab move between cells. Tab past the last cell appends
  a new row and lands on its first cell.
- Right-click opens a menu with Insert row / Delete row / Insert
  column / Delete column. The last column is floored so lezer can
  still parse the remnant as a Table.
- Inside an image cell, the raw `![alt](url)` hides when focus leaves
  the cell — only the image shows at rest, matching the block-image
  invariant outside tables.
- Backspace at the line immediately after a table selects the whole
  table as an atomic unit instead of merging content into the last
  row.

## The tight-Enter override

`@codemirror/lang-markdown` ships `insertNewlineContinueMarkup` as its
default Enter handler. It inspects the syntax tree to decide whether
the list it's continuing is "loose" (CommonMark: blank lines between
items) and, if so, inserts a blank line into the continuation to
preserve the loose style.

In inline live-preview mode loose and tight lists look identical, so
the distinction doesn't earn its weight. Worse, lezer often classifies
a newly-typed list item as loose when it sits near an existing list —
users end up with spurious blank lines between their items.

`insertTightListItem` in `inline-preview.ts` overrides Enter at
`Prec.highest`. Bound behavior:

- Inside a `BulletList`, always emit `\n<indent><marker> ` (tight).
- Inside a task item, emit `\n<indent><marker> [ ] ` — fresh tasks
  start unchecked, even if you pressed Enter on a checked item.
- On an empty continuation (`- ` with nothing after, or `- [ ] ` with
  nothing after), replace the line with just its indent, which exits
  the list the way users expect.

## Mid-typing emphasis

CommonMark's flanking rules say `**foo **` is not emphasis because
the closing `**` is preceded by whitespace. Lezer agrees and doesn't
emit `StrongEmphasis`. Result: while the user types a sentence inside
`**...**`, the bold styling flickers on and off every time they hit
the spacebar.

`supplementMidTypingEmphasis` patches the UX: on the focused line,
scan for matched delimiter pairs (`**`, `__`, `~~`, `*`, `_`) the
cursor sits between and emit the mark ourselves regardless of flanking.
Once the cursor leaves, lezer's opinion wins and the visual reverts to
what will actually persist when the line serializes.

## Bracket / emphasis auto-pairing

`closeBrackets()` pairs `(`, `[`, `{`, `"`, `'`, `*`, `_`, `` ` `` by
default; we extend the markdown language's data facet to include the
markdown-specific symmetric delimiters. `extendEmphasisPair` in
`edit-helpers.ts` adds one special case: typing `*` inside an empty
`*|*` (or `_|_`) promotes the pair to `**|**` — the Obsidian ergonomic
for typing bold quickly without thinking about doubled keystrokes.

## `atomic-theme.ts`

Two CM6 extensions:

- An `EditorView.theme()` with visual / selection / scrollbar styling
  tied to `--atomic-editor-*` custom properties. See the README for
  the full variable list.
- A `HighlightStyle` + `syntaxHighlighting` pairing that colors both
  markdown tokens and the tokens emitted by grammars nested inside
  fenced code blocks. Code-language colors use a Material Palenight
  palette by default and flip to a GitHub-style light palette when
  `[data-theme="light"]` is set.

## `code-languages.ts`

The curated fenced-code language registry. Each language's `load()`
is a dynamic import so the bundler splits each grammar into its own
chunk and users only download grammars they open.

The registry is exposed at the `/code-languages` sub-path so
consumers opt in explicitly; the main entry bundle has no lang-*
dependencies.

## Search

The editor wires `@codemirror/search` with a custom minimal panel:
input + match counter + prev/next/close icon buttons. No replace, no
case/regex/word toggles — reader-first, not editor-first. Keyboard
users get the same behavior CM6's `searchKeymap` ships with
(Cmd/Ctrl+G = next, Shift+same = previous, Escape = close).

External code can detect "is search open?" via the imperative
handle's `isSearchOpen()` method, which delegates to CM6's
`searchPanelOpen(state)`.

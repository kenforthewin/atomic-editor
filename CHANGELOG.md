# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until the package reaches `1.0.0`, minor versions may include breaking API
changes as the public surface stabilizes.

## [Unreleased]

### Fixed

- Reference links render as links only when a matching link reference
  definition exists. `[foo]` with no definition is literal text per CommonMark;
  it previously got link colour, an external-link icon, and hidden brackets —
  which also made a wiki link broken across two lines look like two links.
  Link colour now comes only from the `.cm-atomic-link` decoration; the
  highlight style's `t.link` entry, which could not know whether a reference
  resolved, is gone.
- Wiki-link source collapses through a replaced range rather than a
  `font-size: 0` mark, so the caret keeps its height after a link that ends a
  line. The zero-height inline box left no visible cursor there.

## [0.6.2]

### Changed

- Upgraded the development stack to React 19, TypeScript 7, Vite 8 with
  Rolldown, Vitest 4, and current CodeMirror/Lezer releases. The published
  editor retains its React 18/19 peer range and Node.js 18 runtime support.

### Fixed

- Clean package builds with `cpy-cli` 7 now preserve the exported
  `dist/styles/inline-preview.css` path instead of treating `dist/styles` as a
  file destination.
- Added Vite's asset declarations for TypeScript 7 side-effect import checking
  and migrated the remaining test utility to React 19's `act` API.

## [0.6.1]

### Added

- Expanded the regression harness with a deterministic browser fixture,
  shared Markdown rendering contracts, Chromium/Firefox/WebKit coverage, a
  packed-package consumer build, dependency auditing, and automated dependency
  updates.

### Fixed

- Dragged text selections inside fenced code blocks now remain visible above
  the opaque code backdrop. Selection paint updates live during multi-line
  drags without changing code-block layout or source content.

## [0.6.0]

### Added

- **Highlight syntax.** `==highlighted text==` is now parsed as a
  first-class Markdown extension and rendered consistently in prose and
  WYSIWYG table cells. The `highlightMarkdown` extension is exported for
  consumers composing a custom CodeMirror setup.

### Changed

- Task checkboxes use a larger, theme-aware square control with improved
  baseline alignment, text spacing, keyboard focus visibility, and a stable
  1.2em list-marker footprint.

### Fixed

- Physical continuation lines in list items now hang under their owning
  content column. Nesting depth follows parsed `ListItem` ancestry, so lazy
  continuations, ordered-list marker-width indentation, and odd-but-valid
  CommonMark leading spaces render consistently without changing source bytes.
- Typing `* ` at a list-marker position consumes the emphasis auto-pair's
  generated closer, preventing a stray trailing `*` while retaining italic and
  bold auto-pairing and leaving code blocks untouched.

### Security

- Updated the development toolchain to patched Vite, Vitest, Happy DOM,
  Babel, and `ws` releases; `npm audit` now reports zero vulnerabilities.

## [0.5.1]

### Fixed

- Bare GFM URLs and angle-bracket autolinks remain visible on inactive
  lines and now use the same clickable styling and open behavior as
  explicit Markdown links.
- URL-shaped labels such as
  `[https://label.example](https://destination.example)` keep their
  visible label while the destination remains hidden until the cursor
  enters that link; opening the link uses the actual destination.
- Backslash-escaped URL slashes render cleanly without exposing partial
  escape syntax.

## [0.5.0]

### Added

- **Read-only ("reading") mode.** A new `readOnly` prop (and
  `editorHandle.setReadOnly(...)`) renders the document as a reading
  surface, like Obsidian's Reading view: the whole document stays
  rendered (source never reveals under a caret), typing / paste / table
  editing are disabled, and clicking a link — anywhere on it, not just
  the trailing icon — opens it instead of placing a caret. Task
  checkboxes stay toggleable and find-in-document still works. It's
  backed by a CodeMirror `Compartment`, so toggling reconfigures the
  live view in place (scroll position preserved, no remount). The
  underlying `readOnlyFacet` / `readOnlyExtension` are exported for
  custom-editor composition.

### Fixed

- Restore the React wrapper's documented `window.open` fallback when
  `onLinkClick` is omitted.

## [0.4.3]

Table-editing hardening. The WYSIWYG table widget is the most custom part
of the editor, and its DOM ⇄ markdown round-trip and contenteditable cell
handling were hiding several bugs.

### Fixed

- **Insert column left/right now works.** Inserting a column adds an empty
  cell, and the table model counted columns from lezer `TableCell` nodes —
  which lezer doesn't emit for empty cells — so the new column was dropped
  on re-render even though the document was updated. Columns are now counted
  by splitting the row's raw text, so blank columns survive the round-trip.
- **Typing a literal `|` in a cell no longer corrupts the table.** Cell
  content is now escaped on serialize (`|` → `\|`, newlines flattened), so a
  pipe can't split the row and shift/drop later columns.
- **IME and dead-key composition work in cells.** The cell rebuilt its DOM on
  every input event, which cancelled an in-progress composition — dropping
  CJK input, accents, and dictation. Composition is now left alone until it
  ends.
- **Clicking a styled run (bold/italic/link) in a cell keeps the caret where
  you clicked** instead of jumping it to the end of the cell.
- **The external-link icon in a cell opens its URL.** It was a CSS `::after`
  pseudo-element, which has no event target, so clicking it dispatched no
  event. It's now a real element opened on click (a proper popup-activation
  gesture, so `window.open` isn't blocked).
- Pasting into a cell now inserts a single line of plain text — pasted rich
  HTML, newlines, or pipes no longer land verbatim and corrupt the row.

### Changed

- **Enter in a cell now advances to the next cell** (appending a row past the
  last one), mirroring Tab; Shift reverses direction. Previously it inserted
  a line break the single-line cell couldn't represent.
- Per-keystroke cell edits are tagged as input so the editor's undo history
  coalesces them into one step instead of one per keystroke.

## [0.4.2]

### Fixed

- Typing into a heading (or other line with hidden syntax) immediately after
  clicking it no longer crashes the editor. The inline-preview plugin freezes
  decoration rebuilds during a mouse interaction so a clicked heading's `## `
  prefix doesn't reveal mid-click and jitter. But while frozen it skipped the
  rebuild on doc changes too, handing CodeMirror a stale decoration set whose
  positions no longer matched the document — the `## ` replace then spanned
  the newly-typed line break, throwing `RangeError: Decorations that replace
  line breaks may not be specified via plugins` and corrupting the heightmap
  (`No tile at position …`, broken scroll-into-view, content "jumping"). The
  freeze now still rebuilds on document changes; it only suppresses the
  selection-driven reveal it was meant to.

## [0.4.1]

### Fixed

- `--atomic-editor-selection-bg` now actually takes effect. CodeMirror's base
  theme styles the active selection with a deeper selector than the package
  used (`&dark.cm-focused > .cm-scroller > .cm-selectionLayer
  .cm-selectionBackground`), so the token was silently overridden by the
  default selection color. The rule now mirrors that selector depth (the same
  approach `oneDark` takes), so the configured selection color applies in both
  themes.

## [0.4.0]

### Added

- `TablesConfig` is now exported from the package entry, so consumers passing
  `onLinkClick` to `tables()` can import the option type (the sibling
  `InlinePreviewConfig` and wiki-link types were already exported).
- The light theme now defines `--atomic-editor-accent-soft` and
  `--atomic-editor-initial-reveal-bg` / `-strong`. These were referenced but
  unset under `[data-theme="light"]`, so the blockquote rail and the
  reveal-on-arrival highlight previously borrowed dark-tuned values on a pale
  backdrop.

### Changed

- **Default link color** shifted from a standalone blue to an indigo that
  coordinates with the violet accent (`--atomic-editor-link` `#818cf8`,
  `--atomic-editor-link-hover` `#a5b4fc`; light mode uses violet). Set those
  variables to restore any previous color.
- Fenced code blocks now render with a subtle left rail so the block reads as
  a contained unit. The rail is an inset box-shadow, so line-box geometry (and
  CM6's height measurement) is unchanged.
- Inline-preview decorations are now built in a single syntax-tree walk per
  update instead of two, lowering the per-keystroke cost on large documents.
  No behavioral change.

### Fixed

- Mid-typing emphasis no longer flashes false italic inside intra-word
  underscores (e.g. `snake_case_var`), matching CommonMark's flanking rules.
- The find panel's match counter now reads `9999+` past its cap instead of a
  misleadingly exact count.
- Wiki-link resolution results are now capped (LRU by insertion), so a long
  session that scrolls through many distinct targets no longer grows the cache
  without bound.

## [0.3.0]

### Added

- **Wiki-link extension for atom-style `[[...]]` links.** Consumers can now
  compose `wikiLinks()` into the editor to render labeled wiki links, resolve
  bare targets asynchronously, open links from rendered text, and provide
  CodeMirror autocomplete suggestions. The extension supports custom
  serialization, resolver policies, debounced suggestions, and leaves draft
  links editable while the cursor is inside them.
- **Code-fence auto-close.** Typing an opening triple-backtick fence now inserts
  the matching closing fence so a fence added in the middle of a note does not
  swallow all following content.
- **Demo wiki-link deeplinks.** The dev demo includes sample wiki-link
  suggestions, async resolution, and a lightweight deeplink readout for manual
  testing.

### Fixed

- **Markdown link icon click behavior.** Clicking the rendered external-link
  icon next to a markdown link no longer expands the raw markdown; only clicking
  the link text itself enters edit mode.
- **Missing wiki-link Backspace behavior.** Backspacing immediately after a
  rendered missing bare link now first reveals the raw `[[...]]` source, then
  normal Backspace edits inside the link instead of pulling the rendered link
  through preceding content.

### Changed

- The dev server now binds to `0.0.0.0` and accepts arbitrary dev hostnames,
  which makes package-level testing easier from LAN and tunneled environments.

## [0.2.1]

### Fixed

- **Crash on multi-line link / image titles.** A markdown link or image
  whose title wraps across lines — e.g. `[text](url "first\nsecond")` —
  threw `RangeError: Decorations that replace line breaks may not be
  specified via plugins` and took the editor down on mount. Root cause:
  the inline-preview `ViewPlugin` hides syntax tokens via
  `Decoration.replace`, and CM6 forbids plugin-sourced replaces from
  crossing a newline (block / line-spanning decorations must come from a
  `StateField`). Lezer legitimately emits such nodes for wrapped
  `LinkTitle` / image-title constructs. Every replace in the builder is
  now routed through a `pushReplace` helper that splits multi-line
  ranges into per-line segments; the first segment keeps any widget, so
  bullet / checkbox markers still render exactly once.

## [0.2.0]

### Added

- **`initialRevealText` prop + `revealText(query)` imperative method**
  for arriving-from-search-result navigation. Scrolls the first match
  near the top of its scroll parent (handles editors embedded in a
  larger scrolling shell) and paints a 3.2 s fade-out highlight — no
  search panel, no cursor move, no lingering UI. Matcher falls back
  progressively (exact → whitespace-collapsed → individual lines →
  truncated prefixes at 140 and 80 chars) so hits resolve even when
  the query came from an LLM-massaged snippet that doesn't match the
  source byte-for-byte.
- CSS variables `--atomic-editor-initial-reveal-bg` and
  `--atomic-editor-initial-reveal-bg-strong` for theming the peak and
  settled colors of the reveal highlight independently of the main
  search-match palette.

## [0.1.1]

### Fixed

- **Click routing after block widgets.** Clicks on lines below a table
  would route the caret to the line below the one visually targeted —
  most visible as "clicking the blank line above a heading placed the
  caret on the heading". Root cause: `.cm-atomic-table` used vertical
  `margin` for rhythm, which `getBoundingClientRect` (CM6's widget
  measurement) excludes but DOM layout reserves. The heightmap ran
  ~17 px short of reality for every line below the table. Changed to
  `padding`, which CM6 measures correctly.

### Other

- Shrink heading `padding-top` so the visually-empty strip above a
  heading is ~3 px instead of ~14 px — reduces the separate class of
  "clicked above the heading, landed on it" UX cases.
- Demo homepage now leads with the hero trio (code block, table, task
  list) and uses "Atomic Editor" as the display name in the header and
  tab title.

## [0.1.0] — Initial release

Extracted from [Atomic](https://github.com/kenforthewin/atomic) as a
standalone package.

- `AtomicCodeMirrorEditor` React component with Obsidian-style inline
  live preview: stable layout across active / inactive lines, no
  reveal-during-click, tight-list continuation, pointer-freeze guard
  on mouse interaction.
- Interactive WYSIWYG table widget (in-place cell editing, click-to-
  rebuild, horizontal scroll for wide tables).
- Image block rendering (inline `![](…)` source hidden below a
  rendered image with keep-size placeholder).
- Dark-theme defaults + `[data-theme="light"]` light variant via CSS
  variables only — no JavaScript toggle needed.
- Syntax highlighting for fenced code blocks via the `codeLanguages`
  prop. An optional curated 20-language registry is exported at
  `@atomic-editor/editor/code-languages` with lazy-loaded grammars.
- Minimal search panel (input + match counter + prev/next/close),
  styled to match the editor theme.

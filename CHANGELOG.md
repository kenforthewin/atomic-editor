# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until the package reaches `1.0.0`, minor versions may include breaking API
changes as the public surface stabilizes.

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

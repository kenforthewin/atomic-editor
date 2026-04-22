# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until the package reaches `1.0.0`, minor versions may include breaking API
changes as the public surface stabilizes.

## [0.1.0] — Unreleased

### Initial release

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

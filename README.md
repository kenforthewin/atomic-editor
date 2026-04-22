# @atomic-editor/editor

**A CodeMirror 6 markdown editor with Obsidian-style inline live preview.**
Renders headings, bold, italic, links, images, and tables WYSIWYG while
keeping the raw markdown as the source of truth — so copy, save, and
interop with any other markdown tool Just Works.

Originally built for [Atomic](https://github.com/kenforthewin/atomic),
a personal knowledge base, now standalone.

- **Virtualized**: CM6 renders only the viewport. Open a 500-page atom
  instantly; scrolling stays smooth even on iOS.
- **Layout-stable**: no reflow when you click into a heading or move
  the cursor. Inline decorations rather than block-level widget swaps.
- **WYSIWYG tables**: click into a cell to edit in place; wide tables
  scroll horizontally inside a contained wrapper.
- **Smart lists**: Enter continues tight bullets and task checkboxes,
  Enter on an empty item dedents, `- [ ]` becomes a real checkbox.
- **Fenced code highlighting** for 20+ languages, lazy-loaded per
  fence so unused grammars never hit the wire.
- **Theme with CSS variables** — dark by default, light via a single
  `data-theme="light"` attribute.
- **Minimal search panel** (Ctrl/Cmd+F) styled to match the editor.

[**Live demo →**](https://kenforthewin.github.io/atomic-editor/)

## Install

```bash
npm install @atomic-editor/editor \
  @codemirror/state @codemirror/view @codemirror/commands \
  @codemirror/autocomplete @codemirror/language @codemirror/search \
  @codemirror/lang-markdown \
  @lezer/common @lezer/highlight \
  react react-dom
```

The CodeMirror and React packages are declared as **peer dependencies**
rather than regular deps. You install them alongside the editor so
your bundler resolves a single shared copy — two copies of
`@codemirror/state` in one bundle would silently break the editor's
state-field identity checks.

Fenced-code language grammars (`@codemirror/lang-javascript`,
`@codemirror/lang-python`, etc.) are **optional peers** — install only
the ones you want highlighted. See
[Syntax highlighting](#syntax-highlighting) below.

## Use

```tsx
import { AtomicCodeMirrorEditor } from '@atomic-editor/editor';
import '@atomic-editor/editor/styles.css';

function App() {
  return (
    <AtomicCodeMirrorEditor
      markdownSource={'# Hello\n\nA paragraph.'}
      onMarkdownChange={(md) => console.log(md)}
      onLinkClick={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
    />
  );
}
```

The editor fills its parent — wrap it in a height-bounded flex or grid
container.

### Imperative handle

Pass a ref if you need to drive the editor from outside — e.g. wire
your own toolbar buttons, or open the search panel from a global
keybinding:

```tsx
import { useRef } from 'react';
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from '@atomic-editor/editor';

function App() {
  const editor = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  return (
    <>
      <button onClick={() => editor.current?.openSearch()}>Search</button>
      <AtomicCodeMirrorEditor
        markdownSource={'…'}
        editorHandleRef={editor}
      />
    </>
  );
}
```

Methods: `focus`, `undo`, `redo`, `openSearch(query?)`, `closeSearch`,
`isSearchOpen`, `getMarkdown`, `getContentDOM`.

## Syntax highlighting

Fenced code blocks are plain monospace by default. To enable
highlighting, pass a `codeLanguages` array. `@codemirror/lang-markdown`
dynamically imports each grammar the first time a fence uses it, so
large lists don't bloat the initial bundle.

### Option 1: use the curated list (~20 languages)

```bash
# Install the lang-* peers you want highlighted.
npm install \
  @codemirror/lang-javascript @codemirror/lang-python \
  @codemirror/lang-rust @codemirror/lang-go @codemirror/lang-html \
  @codemirror/lang-css @codemirror/lang-json @codemirror/lang-yaml \
  @codemirror/legacy-modes  # ruby/swift/shell/toml/dockerfile
```

```tsx
import { AtomicCodeMirrorEditor } from '@atomic-editor/editor';
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages';

<AtomicCodeMirrorEditor
  markdownSource={'…'}
  codeLanguages={ATOMIC_CODE_LANGUAGES}
/>
```

See [`src/code-languages.ts`](./src/code-languages.ts) for the full
list (JavaScript, TypeScript, Python, Go, Rust, Ruby, Java, C, C++,
PHP, Swift, Shell, SQL, HTML, CSS, XML, JSON, YAML, TOML, Dockerfile,
Markdown).

### Option 2: bring your own

```tsx
import { LanguageDescription } from '@codemirror/language';
import { python } from '@codemirror/lang-python';

const codeLanguages = [
  LanguageDescription.of({
    name: 'Python',
    alias: ['py'],
    extensions: ['py'],
    load: () => Promise.resolve(python()),
  }),
];

<AtomicCodeMirrorEditor markdownSource={'…'} codeLanguages={codeLanguages} />
```

## Theming

Every color, font, and size reads from a CSS custom property with an
inline fallback. Override on any ancestor of the editor.

The package ships a **light variant** that activates whenever
`data-theme="light"` is set on an ancestor — including `<html>` or
`<body>`. The dark defaults remain unchanged; the light block just
re-maps the same variables.

```html
<html data-theme="light">…</html>
```

| Variable                              | Dark default (auto-light on `[data-theme="light"]`) |
| ------------------------------------- | --------------------------------------------------- |
| `--atomic-editor-font`                | system sans                                         |
| `--atomic-editor-font-mono`           | system mono                                         |
| `--atomic-editor-body-size`           | `1.0625rem`                                         |
| `--atomic-editor-body-leading`        | `1.7`                                               |
| `--atomic-editor-measure`             | `70ch`                                              |
| `--atomic-editor-fg`                  | `#dcddde`                                           |
| `--atomic-editor-fg-muted`            | `#888`                                              |
| `--atomic-editor-fg-faint`            | `#666`                                              |
| `--atomic-editor-bg`                  | `#1e1e1e`                                           |
| `--atomic-editor-bg-panel`            | `#252525`                                           |
| `--atomic-editor-bg-surface`          | `#2d2d2d`                                           |
| `--atomic-editor-border`              | `#3d3d3d`                                           |
| `--atomic-editor-accent`              | `#7c3aed`                                           |
| `--atomic-editor-accent-bright`       | `#a78bfa`                                           |
| `--atomic-editor-link`                | `#60a5fa`                                           |
| `--atomic-editor-link-hover`          | `#93c5fd`                                           |
| `--atomic-editor-code-bg`             | subtle dark panel                                   |
| `--atomic-editor-selection-bg`        | accent-tinted 28%                                   |
| `--atomic-editor-search-bg`           | accent-tinted 28%                                   |
| `--atomic-editor-search-bg-active`    | accent-tinted 60%                                   |
| **Code-token colors** (Palenight)     |                                                     |
| `--atomic-editor-hl-keyword`          | `#c792ea`                                           |
| `--atomic-editor-hl-string`           | `#c3e88d`                                           |
| `--atomic-editor-hl-number`           | `#f78c6c`                                           |
| `--atomic-editor-hl-comment`          | `#6a7a82`                                           |
| `--atomic-editor-hl-type`             | `#ffcb6b`                                           |
| `--atomic-editor-hl-function`         | `#82aaff`                                           |
| `--atomic-editor-hl-property`         | `#82aaff`                                           |
| `--atomic-editor-hl-regexp`           | `#f07178`                                           |
| `--atomic-editor-hl-escape`           | `#89ddff`                                           |
| `--atomic-editor-hl-tag`              | `#f07178`                                           |
| `--atomic-editor-hl-variable`         | `#eeffff`                                           |
| `--atomic-editor-hl-operator`         | `#89ddff`                                           |
| `--atomic-editor-hl-invalid`          | `#ff5370`                                           |

## Low-level extensions

If you want to assemble your own CM6 editor but still use pieces of
this package, every extension factory is individually exported:

```ts
import {
  inlinePreview, // live preview decorations
  imageBlocks,   // rendered image widgets
  tables,        // WYSIWYG table widget
  atomicEditorTheme,
  atomicMarkdownSyntax,
  extendEmphasisPair,
} from '@atomic-editor/editor';
```

## Design notes

See [docs/architecture.md](./docs/architecture.md) for the full design
rationale. Short version:

- **Raw markdown is the source of truth.** All decorations are
  view-only — copy, save, and round-trip to any markdown parser are
  identical to what you'd expect from a plain textarea.
- **No layout shifts.** Every line has a stable height regardless of
  cursor position. Inline decorations hide syntax tokens on inactive
  lines without changing line heights.
- **Narrow invalidation.** Decoration rebuilds only touch lines whose
  content (or surrounding trigger characters) changed, so editing a
  paragraph in a 50KB doc costs O(change size), not O(doc).
- **Mouse-freeze guard.** Clicks don't trigger a decoration rebuild
  mid-interaction — eliminates a class of cursor-drift bugs.
- **iOS-aware.** Momentum scroll halts were investigated and fixed;
  the `MinimalCodeMirrorEditor` and `NoPreviewCodeMirrorEditor` flavors
  in the demo exist as bisection tools for any future scroll issues.

## Contributing

```bash
git clone https://github.com/kenforthewin/atomic-editor
cd atomic-editor
npm install
npm run dev        # demo dev server at http://localhost:5173
npm test           # vitest unit tests
npm run build      # tsc emit to dist/
npm run test:e2e   # Playwright probe suite against the demo
```

The Playwright suite (`scripts/test-editor.mjs`) is the primary
regression-catching tool — ~33 probes covering CLS during idle /
scroll / typing, click-freeze timing, block-type decorations
(headings, lists, tasks, tables, images, fences, HRs), copy-as-raw-
markdown, tight-list continuation, escape handling, and late-doc
rendering via the parser-progress mechanic. Run after any change to
the editor's extensions.

Issues and PRs welcome.

## License

MIT. See [LICENSE](./LICENSE).

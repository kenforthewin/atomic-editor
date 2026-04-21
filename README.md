# @atomic/editor

CodeMirror 6 markdown editor with Obsidian-style inline live preview —
extracted from the [Atomic](https://github.com/kenforthewin/atomic) note app
so it can be reused and, eventually, open-sourced as its own project.

Currently an internal workspace package. API may change without notice.

## Install

```bash
npm install @atomic/editor
```

You also need the CM6 peer deps — if you don't have them already,
```bash
npm install \
  @codemirror/state @codemirror/view @codemirror/commands \
  @codemirror/language @codemirror/lang-markdown @codemirror/legacy-modes \
  @codemirror/lang-cpp @codemirror/lang-css @codemirror/lang-go \
  @codemirror/lang-html @codemirror/lang-java @codemirror/lang-javascript \
  @codemirror/lang-json @codemirror/lang-php @codemirror/lang-python \
  @codemirror/lang-rust @codemirror/lang-sql @codemirror/lang-xml \
  @codemirror/lang-yaml \
  @lezer/common @lezer/highlight
```

The language packages are declared as peers because the fenced-code
language registry lazy-imports them on demand — they'd double-bundle
otherwise.

## Use

```tsx
import { AtomicCodeMirrorEditor } from '@atomic/editor';
import '@atomic/editor/styles.css';

function MyView() {
  return (
    <AtomicCodeMirrorEditor
      markdownSource="# Hello\n\nA paragraph."
      onMarkdownChange={(md) => console.log(md)}
      onLinkClick={(url) => window.open(url, '_blank')}
    />
  );
}
```

`onLinkClick` defaults to `window.open(url, '_blank', 'noopener,noreferrer')`.
In a desktop shell (Tauri / Electron / Capacitor) you'll want to pass your
own opener so links route through the host's external-URL mechanism.

## Theming

All colors, fonts, and sizes read from CSS custom properties with
sensible dark defaults. Override on any ancestor of the editor to
theme it. The full set:

| Property                        | Default fallback                    |
| ------------------------------- | ----------------------------------- |
| `--atomic-editor-font`          | system sans                         |
| `--atomic-editor-font-mono`     | system mono                         |
| `--atomic-editor-body-size`     | `1.0625rem`                         |
| `--atomic-editor-body-leading`  | `1.7`                               |
| `--atomic-editor-measure`       | `70ch`                              |
| `--atomic-editor-fg`            | `#dcddde`                           |
| `--atomic-editor-fg-muted`      | `#888`                              |
| `--atomic-editor-fg-faint`      | `#666`                              |
| `--atomic-editor-bg`            | `#1e1e1e`                           |
| `--atomic-editor-bg-panel`      | `#252525`                           |
| `--atomic-editor-bg-surface`    | `#2d2d2d`                           |
| `--atomic-editor-border`        | `#3d3d3d`                           |
| `--atomic-editor-accent`        | `#7c3aed`                           |
| `--atomic-editor-accent-bright` | `#a78bfa`                           |
| `--atomic-editor-link`          | `#60a5fa`                           |
| `--atomic-editor-link-hover`    | `#93c5fd`                           |
| `--atomic-editor-code-bg`       | computed from `#2d2d2d` + black 12% |

## What's inside

See `docs/codemirror-editor.md` in the parent Atomic repo for the full
design rationale — in short: CM6 for native virtualization, inline
decorations (not block widgets) to keep the layout stable, a
ViewPlugin that force-parses through the viewport, a mouse-freeze
mechanic so clicks don't shift layout mid-interaction, a tight-list
Enter handler that sidesteps lang-markdown's loose-list inference.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

// Package CSS custom properties. Every value below falls back to a
// dark-neutral default; consumers override by setting the prefixed vars
// (`--atomic-editor-*`) at any ancestor of the editor. The defaults are
// deliberately unscoped so the package is usable standalone without
// forcing the consumer to theme it first.

export const atomicEditorTheme: Extension = EditorView.theme(
  {
    '&': {
      color: 'var(--atomic-editor-fg, #dcddde)',
      backgroundColor: 'transparent',
      fontFamily: 'var(--atomic-editor-font, system-ui, -apple-system, BlinkMacSystemFont, sans-serif)',
      fontSize: 'var(--atomic-editor-body-size, 1rem)',
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily: 'var(--atomic-editor-font, system-ui, -apple-system, BlinkMacSystemFont, sans-serif)',
      lineHeight: 'var(--atomic-editor-body-leading, 1.7)',
      overflow: 'auto',
    },
    '.cm-content': {
      caretColor: 'var(--atomic-editor-accent-bright, #a78bfa)',
      padding: '0',
      paddingBottom: '40vh',
    },
    '.cm-line': {
      padding: '0',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--atomic-editor-accent-bright, #a78bfa)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, ::selection, .cm-selectionBackground': {
      backgroundColor:
        'var(--atomic-editor-selection-bg, color-mix(in srgb, #7c3aed 28%, #1e1e1e 72%))',
    },
    '.cm-activeLine': {
      backgroundColor: 'transparent',
    },
    '.cm-gutters': {
      display: 'none',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--atomic-editor-bg-surface, #2d2d2d)',
      color: 'var(--atomic-editor-fg, #dcddde)',
      border: '1px solid var(--atomic-editor-border, #3d3d3d)',
      borderRadius: '6px',
    },
    '.cm-panels': {
      backgroundColor: 'var(--atomic-editor-bg-panel, #252525)',
      color: 'var(--atomic-editor-fg, #dcddde)',
      borderColor: 'var(--atomic-editor-border, #3d3d3d)',
    },
    '.cm-panel.cm-search': {
      padding: '8px 12px',
      fontFamily: 'var(--atomic-editor-font, system-ui, sans-serif)',
    },
    '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
      fontFamily: 'var(--atomic-editor-font, system-ui, sans-serif)',
      fontSize: '0.8125rem',
    },
    '.cm-panel.cm-search input[type=text]': {
      backgroundColor: 'var(--atomic-editor-bg, #1e1e1e)',
      color: 'var(--atomic-editor-fg, #dcddde)',
      border: '1px solid var(--atomic-editor-border, #3d3d3d)',
      borderRadius: '4px',
      padding: '4px 8px',
    },
    '.cm-panel.cm-search button': {
      backgroundColor: 'transparent',
      color: 'var(--atomic-editor-fg-muted, #888)',
      border: '1px solid var(--atomic-editor-border, #3d3d3d)',
      borderRadius: '4px',
      padding: '4px 10px',
      cursor: 'pointer',
    },
    '.cm-searchMatch': {
      backgroundColor:
        'var(--atomic-editor-search-bg, color-mix(in srgb, #7c3aed 26%, transparent 74%))',
      borderRadius: '2px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor:
        'var(--atomic-editor-search-bg-active, color-mix(in srgb, #7c3aed 60%, transparent 40%))',
      outline: '1px solid var(--atomic-editor-accent-bright, #a78bfa)',
    },
  },
  { dark: true },
);

// Markdown syntax tinting. Intentionally muted for the punctuation tokens
// (#, *, `, [, ]) so the surrounding prose reads cleanly; the headings
// and structural tokens get real visual weight. Most of these tokens are
// hidden on inactive lines by the inline-preview extension — coloring
// them matters mainly for the editing view.
export const atomicMarkdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700' },
  { tag: t.heading2, fontWeight: '700' },
  { tag: t.heading3, fontWeight: '700' },
  { tag: t.heading4, fontWeight: '700' },
  { tag: [t.heading5, t.heading6], fontWeight: '700' },

  { tag: t.strong, fontWeight: '700', color: 'var(--atomic-editor-fg, #dcddde)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--atomic-editor-fg, #dcddde)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--atomic-editor-fg-muted, #888)' },

  {
    tag: [t.monospace],
    fontFamily: 'var(--atomic-editor-font-mono, ui-monospace, monospace)',
    color: 'var(--atomic-editor-link, #60a5fa)',
  },

  { tag: t.link, color: 'var(--atomic-editor-link, #60a5fa)' },
  { tag: t.url, color: 'var(--atomic-editor-link, #60a5fa)' },

  { tag: t.processingInstruction, color: 'var(--atomic-editor-fg-faint, #666)' },
  { tag: t.contentSeparator, color: 'var(--atomic-editor-fg-faint, #666)' },
  { tag: t.quote, color: 'var(--atomic-editor-fg-muted, #888)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--atomic-editor-fg, #dcddde)' },
  { tag: t.meta, color: 'var(--atomic-editor-fg-faint, #666)' },

  { tag: t.punctuation, color: 'var(--atomic-editor-fg-faint, #666)' },
  { tag: t.operator, color: 'var(--atomic-editor-fg-faint, #666)' },
]);

export const atomicMarkdownSyntax = syntaxHighlighting(atomicMarkdownHighlight);

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
      // CM6's base theme sets `min-width: max-content` on
      // `.cm-content` so it always grows to fit its widest child.
      // That defeats every width constraint on our block widgets
      // (tables especially): a wide table tells `.cm-content`
      // "I'm 800px", content grows to 800px, and the scroller
      // shows horizontal scroll — the "editor overflows
      // horizontally" behavior you see on mobile when a wide
      // table enters the viewport. Forcing `min-width: 0` lets
      // the content box stay at its parent width; wide children
      // are expected to own their own horizontal scroll (see
      // `.cm-atomic-table-scroll`) rather than pushing the
      // content.
      minWidth: '0',
    },
    '.cm-line': {
      padding: '0',
      // Force-wrap words that have no natural break opportunity —
      // long URLs, base64 chunks, and code tokens that would
      // otherwise overflow the line and push the scroll container
      // wider than the viewport. Without this, long unbroken
      // tokens blow past the reading column and we get the
      // transient horizontal overflow on mobile.
      overflowWrap: 'anywhere',
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

// Markdown syntax tinting plus highlight colors for tokens emitted by
// grammars nested inside fenced code blocks (see `code-languages.ts`).
// Punctuation tokens (#, *, `, [, ]) stay muted so the surrounding
// prose reads cleanly; headings and structural markdown tokens get
// real visual weight. Code-language tokens (keyword, string, number,
// etc.) adopt a Material Palenight palette tuned for dark backgrounds;
// override any color via the `--atomic-editor-hl-*` CSS variables.
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
  { tag: t.quote, color: 'var(--atomic-editor-fg-muted, #888)' },
  { tag: t.list, color: 'var(--atomic-editor-fg, #dcddde)' },
  { tag: t.meta, color: 'var(--atomic-editor-fg-faint, #666)' },

  // Nested code-language tokens. `@codemirror/lang-markdown` wires the
  // grammars from `code-languages.ts` into fenced blocks whose info
  // string matches — each fence gets a real AST, so tags below apply.
  {
    tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.self],
    color: 'var(--atomic-editor-hl-keyword, #c792ea)',
  },
  {
    tag: [t.string, t.special(t.string), t.character, t.attributeValue],
    color: 'var(--atomic-editor-hl-string, #c3e88d)',
  },
  {
    tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom],
    color: 'var(--atomic-editor-hl-number, #f78c6c)',
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--atomic-editor-hl-comment, #6a7a82)',
    fontStyle: 'italic',
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)],
    color: 'var(--atomic-editor-hl-type, #ffcb6b)',
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
    color: 'var(--atomic-editor-hl-function, #82aaff)',
  },
  {
    tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)],
    color: 'var(--atomic-editor-hl-property, #82aaff)',
  },
  { tag: t.regexp, color: 'var(--atomic-editor-hl-regexp, #f07178)' },
  { tag: t.escape, color: 'var(--atomic-editor-hl-escape, #89ddff)' },
  {
    tag: [t.tagName, t.angleBracket],
    color: 'var(--atomic-editor-hl-tag, #f07178)',
  },
  {
    tag: [t.variableName, t.labelName, t.definition(t.variableName), t.local(t.variableName)],
    color: 'var(--atomic-editor-hl-variable, #eeffff)',
  },
  { tag: t.operator, color: 'var(--atomic-editor-hl-operator, #89ddff)' },
  { tag: t.invalid, color: 'var(--atomic-editor-hl-invalid, #ff5370)' },

  { tag: [t.punctuation, t.bracket, t.squareBracket, t.paren, t.brace], color: 'var(--atomic-editor-fg-muted, #888)' },
]);

export const atomicMarkdownSyntax = syntaxHighlighting(atomicMarkdownHighlight);

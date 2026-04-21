export { AtomicCodeMirrorEditor } from './AtomicCodeMirrorEditor';
export type {
  AtomicCodeMirrorEditorHandle,
  AtomicCodeMirrorEditorProps,
} from './AtomicCodeMirrorEditor';

// The curated fenced-code language registry. Exposed so consumers that
// embed their own CM6 editor alongside this package (or wrap a
// different markdown editor that also needs a language list) can share
// one source of truth.
export { ATOMIC_CODE_LANGUAGES } from './code-languages';

// Individual extension factories. Exposed so the harness (and any
// future experiments) can build a stripped-down editor that opts
// into a subset of the package's features — useful for bisecting
// regressions and for consumers that only want, say, the tables
// widget without inline preview.
export { inlinePreview } from './inline-preview';
export type { InlinePreviewConfig } from './inline-preview';
export { imageBlocks } from './image-blocks';
export { tables } from './table-widget';
export { atomicEditorTheme, atomicMarkdownSyntax } from './atomic-theme';
export { extendEmphasisPair } from './edit-helpers';

export { AtomicCodeMirrorEditor } from './AtomicCodeMirrorEditor';
export type { AtomicCodeMirrorEditorProps } from './AtomicCodeMirrorEditor';

// The curated fenced-code language registry. Exposed so consumers that
// embed their own CM6 editor alongside this package (or wrap a
// different markdown editor that also needs a language list) can share
// one source of truth.
export { ATOMIC_CODE_LANGUAGES } from './code-languages';

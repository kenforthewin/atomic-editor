import { describe, expect, it, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';

type Mounted = { host: HTMLElement; root: Root };
const mounts: Mounted[] = [];

function mount(markdown: string): Mounted {
  const host = document.createElement('div');
  host.style.width = '600px';
  host.style.height = '400px';
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<AtomicCodeMirrorEditor markdownSource={markdown} />);
  });
  const m = { host, root };
  mounts.push(m);
  return m;
}

afterEach(() => {
  for (const m of mounts.splice(0)) {
    act(() => m.root.unmount());
    m.host.remove();
  }
});

// Regression: lezer's markdown parser emits some nodes whose range
// legitimately spans a line break — most reproducibly, a link whose
// title runs across multiple lines:
//
//   [text](url "title
//   that wraps")
//
// The inline-preview plugin hides these tokens via Decoration.replace
// to get the live-preview effect on inactive lines. But ViewPlugin
// decorations are forbidden from replacing a line break, so a naive
// `Decoration.replace({}).range(node.from, node.to)` on such a token
// throws "Decorations that replace line breaks may not be specified
// via plugins" when the builder runs.
describe('multi-line markdown nodes do not crash the inline-preview plugin', () => {
  it.each([
    ['multi-line link title', '[label](https://example.com "first line\nsecond line")'],
    ['multi-line image title', '![alt](https://example.com/x.png "first\nsecond")'],
  ])('%s', (_name, markdown) => {
    expect(() => mount(markdown)).not.toThrow();
  });
});

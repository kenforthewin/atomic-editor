import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';

const hosts: HTMLElement[] = [];
const roots: Root[] = [];

function mount(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.style.width = '720px';
  host.style.height = '640px';
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<AtomicCodeMirrorEditor markdownSource={markdown} />));
  return host;
}

/**
 * Link marks over the first line only. The definition line carries a URL of
 * its own, which is styled as a link in its own right; scoping to line one
 * keeps these assertions about the reference that uses it.
 */
function firstLineLinks(host: HTMLElement): HTMLElement[] {
  const firstLine = host.querySelector('.cm-content .cm-line');
  return [...(firstLine?.querySelectorAll<HTMLElement>('.cm-atomic-link') ?? [])];
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const host of hosts.splice(0)) host.remove();
});

describe('reference links', () => {
  it('leaves a shortcut reference with no definition as literal text', () => {
    const host = mount('see [note] below');

    expect(firstLineLinks(host)).toHaveLength(0);
    expect(host.querySelector('.cm-content')?.textContent).toBe(
      'see [note] below',
    );
  });

  it('renders a shortcut reference whose definition follows it', () => {
    const host = mount('see [note] below\n\n[note]: https://example.com');

    const links = firstLineLinks(host);
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('note');
  });

  it('renders a full reference, matching its label case-insensitively', () => {
    const host = mount('see [the note][Ref A] below\n\n[ref a]: /url');

    const links = firstLineLinks(host);
    expect(links).toHaveLength(1);
    // The label itself stays visible — reference labels are not hideable
    // syntax — so the mark covers the whole `[the note][Ref A]` span.
    expect(links[0].textContent).toContain('the note');
  });

  it('renders a collapsed reference through its own text', () => {
    const host = mount('see [note][] below\n\n[note]: /url');

    expect(firstLineLinks(host)).toHaveLength(1);
  });

  it('leaves a full reference with no matching definition as literal text', () => {
    const host = mount('see [the note][missing] below\n\n[other]: /url');

    expect(firstLineLinks(host)).toHaveLength(0);
    expect(host.querySelector('.cm-content')?.textContent).toContain(
      '[the note][missing]',
    );
  });

  it('still renders an inline link that carries its own destination', () => {
    const host = mount('see [note](https://example.com) below');

    const links = firstLineLinks(host);
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('note');
  });
});

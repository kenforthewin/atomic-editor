import { describe, expect, it, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorState, type EditorStateConfig, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';
import { wikiLinks } from '../wiki-links';

type Mounted = { host: HTMLElement; root: Root };
const mounts: Mounted[] = [];
const views: EditorView[] = [];

function mount(markdown: string, options: Parameters<typeof wikiLinks>[0] = {}): Mounted {
  const host = document.createElement('div');
  host.style.width = '600px';
  host.style.height = '400px';
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <AtomicCodeMirrorEditor
        markdownSource={markdown}
        extensions={[
          wikiLinks({
            resolve: async (target) => ({ target, label: 'Resolved Target', status: 'resolved' }),
            ...options,
          }),
        ]}
      />,
    );
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
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
});

function makeView(
  doc: string,
  extensions: Extension,
  selection?: EditorStateConfig['selection'],
): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions, selection }),
  });
  views.push(view);
  return view;
}

describe('wikiLinks', () => {
  it('renders labeled wiki links without exposing the target as visible link text', () => {
    const { host } = mount('Linked atom: [[atom-123|Project Atlas]]');

    const link = host.querySelector<HTMLElement>('.cm-atomic-wiki-link');
    expect(link).not.toBeNull();
    expect(link?.dataset.wikiLinkTarget).toBe('atom-123');
    expect(link?.textContent).toBe('Project Atlas');

    const hiddenSyntax = host.querySelector('.cm-atomic-wiki-link-hidden-syntax');
    expect(hiddenSyntax?.textContent).toContain('atom-123');
  });

  it('leaves inline-code wiki-link text untouched', () => {
    const { host } = mount('Code: `[[atom-123|Project Atlas]]`');

    expect(host.querySelector('.cm-atomic-wiki-link')).toBeNull();
    expect(host.textContent).toContain('[[atom-123|Project Atlas]]');
  });

  it('opens on plain click by default when an opener is configured', () => {
    const onOpen = vi.fn();
    const { host } = mount('Linked atom: [[atom-123|Project Atlas]]', {
      onOpen,
    });

    host.querySelector<HTMLElement>('.cm-atomic-wiki-link')?.click();
    expect(onOpen).toHaveBeenCalledWith('atom-123');
  });

  it('can require modifier-click for opening', () => {
    const onOpen = vi.fn();
    const { host } = mount('Linked atom: [[atom-123|Project Atlas]]', {
      onOpen,
      openOnClick: false,
    });

    host.querySelector<HTMLElement>('.cm-atomic-wiki-link')?.click();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not resolve a bare wiki link while the cursor is inside it', () => {
    const resolve = vi.fn(async (target: string) => ({ target, label: 'Resolved Target', status: 'resolved' as const }));
    const cursorInsideTarget = 'Draft: [['.length + 2;
    const view = makeView(
      'Draft: [[atom-123]]',
      [wikiLinks({ resolve })],
      { anchor: cursorInsideTarget },
    );

    expect(resolve).not.toHaveBeenCalled();

    view.dispatch({ selection: { anchor: view.state.doc.length } });

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith('atom-123');
  });

  it('does not resolve or decorate bare links rejected by the resolver policy', () => {
    const resolve = vi.fn(async (target: string) => ({ target, label: 'Resolved Target', status: 'resolved' as const }));
    const view = makeView('Draft: [[not-an-atom-id]]', [
      wikiLinks({
        resolve,
        shouldResolve: () => false,
      }),
    ]);

    expect(resolve).not.toHaveBeenCalled();
    expect(view.dom.querySelector('.cm-atomic-wiki-link')).toBeNull();
    expect(view.dom.textContent).toContain('[[not-an-atom-id]]');
  });

  it('reveals a rendered bare link before backspacing through it', () => {
    const doc = 'Before [[missing-target]] after';
    const view = makeView(
      doc,
      [
        wikiLinks({
          resolve: async (target) => ({ target, label: 'Missing atom', status: 'missing' }),
        }),
      ],
      { anchor: 'Before [[missing-target]]'.length },
    );

    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    const dispatched = view.contentDOM.dispatchEvent(event);

    expect(dispatched).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe('Before [[missing-target'.length);
  });
});

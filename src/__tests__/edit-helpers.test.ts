import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { autoCloseCodeFenceInput } from '../edit-helpers';

const views: EditorView[] = [];
const hosts: HTMLElement[] = [];

function makeView(doc: string, cursor: number): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
    }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const host of hosts.splice(0)) host.remove();
});

describe('autoCloseCodeFenceInput', () => {
  it('inserts a matching closing fence when the third backtick opens a fence', () => {
    const doc = 'Before\n``\nAfter';
    const cursor = 'Before\n``'.length;
    const view = makeView(doc, cursor);

    expect(autoCloseCodeFenceInput(view, cursor, cursor, '`')).toBe(true);
    expect(view.state.doc.toString()).toBe('Before\n```\n```\nAfter');
    expect(view.state.selection.main.head).toBe('Before\n```'.length);
  });

  it('consumes a paired closing backtick inserted by closeBrackets', () => {
    const doc = 'Before\n```\nAfter';
    const cursor = 'Before\n``'.length;
    const view = makeView(doc, cursor);

    expect(autoCloseCodeFenceInput(view, cursor, cursor, '`')).toBe(true);
    expect(view.state.doc.toString()).toBe('Before\n```\n```\nAfter');
    expect(view.state.selection.main.head).toBe('Before\n```'.length);
  });

  it('does not auto-close when typing a manual closing fence inside a code block', () => {
    const doc = '```ts\nconst x = 1;\n``';
    const cursor = doc.length;
    const view = makeView(doc, cursor);

    expect(autoCloseCodeFenceInput(view, cursor, cursor, '`')).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });
});

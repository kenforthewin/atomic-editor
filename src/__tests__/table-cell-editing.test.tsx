import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorProps,
} from '../AtomicCodeMirrorEditor';

const hosts: { host: HTMLElement; root: Root }[] = [];

function mount(props: AtomicCodeMirrorEditorProps) {
  const host = document.createElement('div');
  host.style.width = '600px';
  host.style.height = '400px';
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<AtomicCodeMirrorEditor {...props} />);
  });
  hosts.push({ host, root });
  return { host };
}

afterEach(() => {
  for (const { host, root } of hosts.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

const TABLE = [
  '| Name | Note |',
  '| --- | --- |',
  '| helloworld | x |',
].join('\n');

function bodyCellSource(host: HTMLElement): HTMLElement {
  const cell = host.querySelector<HTMLElement>(
    'tbody td .cm-atomic-table-cell-source',
  );
  expect(cell).not.toBeNull();
  return cell!;
}

function cellOf(source: HTMLElement): HTMLElement {
  const cell = source.parentElement;
  expect(cell).not.toBeNull();
  return cell!;
}

/** Simulate a keystroke: set the source text and fire the input handler. */
function typeIntoCell(source: HTMLElement, text: string): void {
  act(() => {
    source.focus();
    source.textContent = text;
    source.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
}

describe('table cell editing whitespace', () => {
  it('keeps a trailing space so typing "hello world" works', () => {
    const { host } = mount({ markdownSource: TABLE });
    const source = bodyCellSource(host);

    // Space after "hello" is temporarily trailing — must survive commit.
    typeIntoCell(source, 'hello ');
    expect(cellOf(source).dataset.raw).toBe('hello ');

    // Continue typing on whatever commit left in the DOM (mirrors real
    // keystroke flow: rebuild from dataset.raw, then append the next char).
    typeIntoCell(source, `${source.textContent ?? ''}world`);
    expect(cellOf(source).dataset.raw).toBe('hello world');
  });

  it('keeps consecutive spaces between words', () => {
    const { host } = mount({ markdownSource: TABLE });
    const source = bodyCellSource(host);

    typeIntoCell(source, 'hello world');
    expect(cellOf(source).dataset.raw).toBe('hello world');

    typeIntoCell(source, 'hello  world');
    expect(cellOf(source).dataset.raw).toBe('hello  world');
  });
});

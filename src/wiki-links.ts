import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { Prec, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';

export type WikiLinkStatus = 'resolved' | 'loading' | 'missing' | 'unresolved';

export interface WikiLinkSuggestion {
  target: string;
  label: string;
  detail?: string;
  boost?: number;
}

export interface WikiLinkResolvedTarget {
  target: string;
  label: string;
  status?: Exclude<WikiLinkStatus, 'loading'>;
}

export interface WikiLinksConfig {
  suggest?: (query: string) => Promise<WikiLinkSuggestion[]>;
  resolve?: (target: string) => Promise<WikiLinkResolvedTarget | null>;
  shouldResolve?: (target: string) => boolean;
  onOpen?: (target: string) => void;
  openOnClick?: boolean;
  serializeSuggestion?: (suggestion: WikiLinkSuggestion) => string;
  maxSuggestions?: number;
  debounceMs?: number;
}

interface ParsedWikiLink {
  from: number;
  to: number;
  target: string;
  label: string | null;
  labelFrom: number | null;
  labelTo: number | null;
}

interface ResolutionPayload {
  target: string;
  resolved: WikiLinkResolvedTarget | null;
}

interface WikiLinkDecorationState {
  decorations: DecorationSet;
  resolved: Map<string, WikiLinkResolvedTarget | null>;
}

interface WikiLinkCompletion extends Completion {
  suggestion: WikiLinkSuggestion;
}

const WIKI_LINK_QUERY_RE = /\[\[[^\]\n|]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const wikiLinkResolved = StateEffect.define<ResolutionPayload>();

class WikiLinkWidget extends WidgetType {
  constructor(
    private readonly target: string,
    private readonly label: string,
    private readonly status: WikiLinkStatus,
  ) {
    super();
  }

  override eq(other: WikiLinkWidget): boolean {
    return this.target === other.target && this.label === other.label && this.status === other.status;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-atomic-wiki-link cm-atomic-wiki-link-${this.status}`;
    span.dataset.wikiLinkTarget = this.target;
    span.textContent = this.label;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class WikiLinkResolverPlugin {
  private readonly pending = new Set<string>();
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly config: WikiLinksConfig,
    private readonly decorationField: StateField<WikiLinkDecorationState>,
  ) {
    this.resolveVisibleLinks();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.resolveVisibleLinks();
    }
  }

  destroy(): void {
    this.destroyed = true;
  }

  private resolveVisibleLinks(): void {
    if (!this.config.resolve) return;
    const links = findWikiLinksInVisibleRanges(this.view.state.doc, this.view.visibleRanges);
    const resolved = this.view.state.field(this.decorationField).resolved;
    for (const link of links) {
      if (
        link.label ||
        isSelectionInsideLink(this.view.state, link) ||
        !shouldResolveWikiLink(this.config, link.target) ||
        this.pending.has(link.target) ||
        resolved.has(link.target)
      ) {
        continue;
      }
      this.resolve(link.target);
    }
  }

  private resolve(target: string): void {
    if (!this.config.resolve) return;

    this.pending.add(target);
    this.config.resolve(target)
      .then((resolved) => {
        if (!this.destroyed) {
          this.view.dispatch({ effects: wikiLinkResolved.of({ target, resolved }) });
        }
      })
      .catch(() => {
        if (!this.destroyed) {
          this.view.dispatch({ effects: wikiLinkResolved.of({ target, resolved: null }) });
        }
      })
      .finally(() => {
        this.pending.delete(target);
      });
  }
}

export function wikiLinks(config: WikiLinksConfig = {}): Extension {
  const field = StateField.define<WikiLinkDecorationState>({
    create(state) {
      const resolved = new Map<string, WikiLinkResolvedTarget | null>();
      return { resolved, decorations: buildDecorations(state, resolved, config) };
    },
    update(value, transaction) {
      let resolved = value.resolved;
      let resolutionChanged = false;

      for (const effect of transaction.effects) {
        if (!effect.is(wikiLinkResolved)) continue;
        if (resolved === value.resolved) resolved = new Map(value.resolved);
        resolved.set(effect.value.target, effect.value.resolved);
        resolutionChanged = true;
      }

      if (transaction.docChanged || transaction.selection || resolutionChanged) {
        return { resolved, decorations: buildDecorations(transaction.state, resolved, config) };
      }

      return { resolved, decorations: value.decorations.map(transaction.changes) };
    },
    provide: (fieldValue) => EditorView.decorations.from(fieldValue, (value) => value.decorations),
  });

  return [
    field,
    ViewPlugin.define((view) => new WikiLinkResolverPlugin(view, config, field)),
    makeWikiLinkPointerGuard(config),
    wikiLinkEditKeymap(),
    wikiLinkCompletions(config),
    makeWikiLinkClickHandler(config),
  ];
}

function wikiLinkEditKeymap(): Extension {
  return Prec.highest(keymap.of([
    {
      key: 'Backspace',
      run: revealWikiLinkBeforeCursor,
    },
  ]));
}

function wikiLinkCompletions(config: WikiLinksConfig): Extension {
  if (!config.suggest) return [];

  return autocompletion({
    activateOnTyping: true,
    icons: false,
    override: [async (context) => completionSource(context, config)],
  });
}

async function completionSource(
  context: CompletionContext,
  config: WikiLinksConfig,
): Promise<CompletionResult | null> {
  if (!config.suggest) return null;

  const match = context.matchBefore(WIKI_LINK_QUERY_RE);
  if (!match || (match.from === match.to && !context.explicit)) return null;

  const query = match.text.slice(2);
  const debounceMs = config.debounceMs ?? 120;
  if (debounceMs > 0) {
    await delay(debounceMs);
    if (context.aborted) return null;
  }

  const suggestions = dedupeSuggestions(await config.suggest(query)).slice(0, config.maxSuggestions ?? 12);
  if (context.aborted) return null;

  return {
    from: match.from + 2,
    to: context.pos,
    options: suggestions.map((suggestion) => toCompletion(suggestion, config)),
    validFor: /^[^\]\n|]*$/,
  };
}

function toCompletion(suggestion: WikiLinkSuggestion, config: WikiLinksConfig): WikiLinkCompletion {
  return {
    label: suggestion.label,
    detail: suggestion.detail,
    type: 'text',
    boost: suggestion.boost,
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      const selected = (completion as WikiLinkCompletion).suggestion;
      const insert = (config.serializeSuggestion ?? defaultSerializeSuggestion)(selected);
      const replaceTo = view.state.doc.sliceString(to, to + 2) === ']]' ? to + 2 : to;
      view.dispatch({
        changes: { from, to: replaceTo, insert },
        selection: { anchor: from + insert.length },
      });
    },
    suggestion,
  };
}

function makeWikiLinkClickHandler(config: WikiLinksConfig): Extension {
  return EditorView.domEventHandlers({
    click(event) {
      if (!shouldOpenFromEvent(config, event)) return false;
      if (event.button !== 0) return false;

      const link = wikiLinkElementFromEvent(event);
      const wikiTarget = link?.dataset.wikiLinkTarget;
      if (!wikiTarget) return false;

      event.preventDefault();
      event.stopPropagation();
      config.onOpen(wikiTarget);
      return true;
    },
  });
}

function makeWikiLinkPointerGuard(config: WikiLinksConfig): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly onPointerDown = (event: PointerEvent) => {
        if (!shouldOpenFromEvent(config, event)) return;
        if (event.button !== 0) return;
        const link = wikiLinkElementFromEvent(event, this.view.contentDOM);
        if (!link) return;

        // This pointerdown is an open-link gesture, not an edit gesture.
        // Stop CM6 from moving the cursor into the wiki-link source and
        // revealing the raw `[[target|label]]` before the click opens.
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      constructor(readonly view: EditorView) {
        view.dom.addEventListener('pointerdown', this.onPointerDown, true);
      }

      destroy() {
        this.view.dom.removeEventListener('pointerdown', this.onPointerDown, true);
      }
    },
  );
}

function shouldOpenFromEvent(config: WikiLinksConfig, event: MouseEvent): config is WikiLinksConfig & { onOpen: (target: string) => void } {
  if (!config.onOpen) return false;
  if (event.shiftKey || event.altKey) return false;
  return config.openOnClick !== false || event.metaKey || event.ctrlKey;
}

function wikiLinkElementFromEvent(event: MouseEvent, root?: HTMLElement): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const link = target.closest<HTMLElement>('[data-wiki-link-target]');
  if (!link || (root && !root.contains(link))) return null;
  return link;
}

function buildDecorations(
  state: EditorState,
  resolved: ReadonlyMap<string, WikiLinkResolvedTarget | null>,
  config: WikiLinksConfig,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const links = findWikiLinksInVisibleRanges(state.doc, [{ from: 0, to: state.doc.length }]);

  for (const link of links) {
    if (!isSingleLineRange(state, link.from, link.to)) continue;

    if (isSelectionInsideLink(state, link)) {
      builder.add(link.from, link.to, Decoration.mark({ class: 'cm-atomic-wiki-link-active' }));
      continue;
    }

    if (link.label && link.labelFrom != null && link.labelTo != null && link.labelFrom < link.labelTo) {
      builder.add(link.from, link.labelFrom, Decoration.mark({ class: 'cm-atomic-wiki-link-hidden-syntax' }));
      builder.add(
        link.labelFrom,
        link.labelTo,
        Decoration.mark({
          class: 'cm-atomic-wiki-link cm-atomic-wiki-link-resolved',
          attributes: { 'data-wiki-link-target': link.target },
        }),
      );
      builder.add(link.labelTo, link.to, Decoration.mark({ class: 'cm-atomic-wiki-link-hidden-syntax' }));
      continue;
    }

    if (!config.resolve || !shouldResolveWikiLink(config, link.target)) {
      continue;
    }

    const target = resolved.get(link.target);
    const label = target === undefined ? 'Wiki link' : target?.label.trim() || 'Missing link';
    const status: WikiLinkStatus = target === undefined
      ? 'loading'
      : target
        ? target.status ?? 'resolved'
        : 'missing';

    builder.add(link.from, link.to, Decoration.mark({ class: 'cm-atomic-wiki-link-hidden-syntax' }));
    builder.add(
      link.to,
      link.to,
      Decoration.widget({
        widget: new WikiLinkWidget(link.target, label, status),
        side: -1,
      }),
    );
  }

  return builder.finish();
}

function shouldResolveWikiLink(config: WikiLinksConfig, target: string): boolean {
  return config.shouldResolve?.(target) ?? true;
}

function revealWikiLinkBeforeCursor(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) return false;

  const cursor = range.head;
  const link = findWikiLinkEndingAt(view.state.doc, cursor);
  if (!link || link.label) return false;

  view.dispatch({
    selection: { anchor: Math.max(link.from + 2, link.to - 2) },
    scrollIntoView: true,
  });
  return true;
}

function findWikiLinkEndingAt(doc: Text, pos: number): ParsedWikiLink | null {
  if (pos <= 0 || pos > doc.length) return null;
  const line = doc.lineAt(pos);
  return findWikiLinksInLine(line.text, line.from).find((link) => link.to === pos) ?? null;
}

function findWikiLinksInVisibleRanges(doc: Text, ranges: readonly { from: number; to: number }[]): ParsedWikiLink[] {
  const links: ParsedWikiLink[] = [];

  for (const range of ranges) {
    const firstLine = doc.lineAt(range.from);
    const lastLine = doc.lineAt(Math.max(range.from, range.to - 1));
    const fence = fenceStateBeforeLine(doc, firstLine.number);

    for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber++) {
      const line = doc.line(lineNumber);
      const text = line.text;
      const fenceMatch = text.match(FENCE_RE);

      if (!fence.marker && fenceMatch) {
        fence.marker = fenceMatch[1][0] as '`' | '~';
        fence.length = fenceMatch[1].length;
        continue;
      }

      if (fence.marker) {
        if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length) {
          fence.marker = null;
          fence.length = 0;
        }
        continue;
      }

      links.push(...findWikiLinksInLine(text, line.from));
    }
  }

  return links;
}

function findWikiLinksInLine(text: string, lineStart: number): ParsedWikiLink[] {
  const links: ParsedWikiLink[] = [];
  const codeSpans = inlineCodeSpans(text);
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const open = text.indexOf('[[', searchFrom);
    if (open === -1) break;
    if (isInsideAny(open, codeSpans)) {
      searchFrom = open + 2;
      continue;
    }

    const close = text.indexOf(']]', open + 2);
    if (close === -1) break;
    if (isInsideAny(close, codeSpans)) {
      searchFrom = close + 2;
      continue;
    }

    const body = text.slice(open + 2, close);
    const pipe = body.indexOf('|');
    const rawTarget = pipe === -1 ? body : body.slice(0, pipe);
    const rawLabel = pipe === -1 ? null : body.slice(pipe + 1);
    const target = rawTarget.trim();

    if (!target) {
      searchFrom = close + 2;
      continue;
    }

    let label: string | null = null;
    let labelFrom: number | null = null;
    let labelTo: number | null = null;
    if (rawLabel != null) {
      const labelStart = leadingWhitespaceLength(rawLabel);
      const labelEnd = rawLabel.length - trailingWhitespaceLength(rawLabel);
      label = rawLabel.slice(labelStart, labelEnd);
      labelFrom = lineStart + open + 2 + pipe + 1 + labelStart;
      labelTo = lineStart + open + 2 + pipe + 1 + labelEnd;
    }

    links.push({
      from: lineStart + open,
      to: lineStart + close + 2,
      target,
      label,
      labelFrom,
      labelTo,
    });
    searchFrom = close + 2;
  }

  return links;
}

function fenceStateBeforeLine(doc: Text, lineNumber: number): { marker: '`' | '~' | null; length: number } {
  const fence: { marker: '`' | '~' | null; length: number } = { marker: null, length: 0 };
  for (let current = 1; current < lineNumber; current++) {
    const match = doc.line(current).text.match(FENCE_RE);
    if (!match) continue;
    const marker = match[1][0] as '`' | '~';
    const length = match[1].length;
    if (!fence.marker) {
      fence.marker = marker;
      fence.length = length;
    } else if (marker === fence.marker && length >= fence.length) {
      fence.marker = null;
      fence.length = 0;
    }
  }
  return fence;
}

function inlineCodeSpans(text: string): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let pos = 0;

  while (pos < text.length) {
    const start = text.indexOf('`', pos);
    if (start === -1) break;
    let tickCount = 1;
    while (text[start + tickCount] === '`') tickCount++;
    const needle = '`'.repeat(tickCount);
    const end = text.indexOf(needle, start + tickCount);
    if (end === -1) break;
    spans.push({ from: start, to: end + tickCount });
    pos = end + tickCount;
  }

  return spans;
}

function isSelectionInsideLink(state: EditorState, link: ParsedWikiLink): boolean {
  return state.selection.ranges.some((range) => {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    if (from === to) return from > link.from && from < link.to;
    return from < link.to && to > link.from;
  });
}

function isSingleLineRange(state: EditorState, from: number, to: number): boolean {
  const end = Math.max(from, to - 1);
  return state.doc.lineAt(from).number === state.doc.lineAt(end).number;
}

function dedupeSuggestions(suggestions: WikiLinkSuggestion[]): WikiLinkSuggestion[] {
  const seen = new Set<string>();
  const deduped: WikiLinkSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.target)) continue;
    seen.add(suggestion.target);
    deduped.push(suggestion);
  }
  return deduped;
}

function defaultSerializeSuggestion(suggestion: WikiLinkSuggestion): string {
  return `${suggestion.target}|${escapeLabel(suggestion.label)}]]`;
}

function escapeLabel(label: string): string {
  return label.replace(/[\]\|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isInsideAny(pos: number, spans: readonly { from: number; to: number }[]): boolean {
  return spans.some((span) => pos >= span.from && pos < span.to);
}

function leadingWhitespaceLength(value: string): number {
  const match = value.match(/^\s*/);
  return match?.[0].length ?? 0;
}

function trailingWhitespaceLength(value: string): number {
  const match = value.match(/\s*$/);
  return match?.[0].length ?? 0;
}

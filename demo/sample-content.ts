// Deterministic markdown sample generator for the editor harness.
//
// We want reproducible content across reloads and across editor backends so
// perf comparisons are apples-to-apples. A seeded PRNG (mulberry32) drives
// paragraph length, list length, and block-type selection; the same size
// bucket always produces the same document bytes.

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'atom', 'graph', 'tag', 'embedding', 'vector', 'semantic', 'reader', 'wiki',
  'canvas', 'chat', 'agent', 'retrieval', 'chunk', 'similarity', 'index', 'query',
  'markdown', 'editor', 'virtualize', 'viewport', 'render', 'prose', 'block',
  'paragraph', 'heading', 'fence', 'list', 'quote', 'link', 'image', 'table',
  'pipeline', 'transport', 'facade', 'store', 'subscribe', 'callback', 'payload',
  'hydrate', 'serialize', 'diff', 'cursor', 'selection', 'decoration', 'widget',
  'syntax', 'parser', 'tree', 'token', 'highlight', 'theme', 'dark', 'panel',
];

// Deterministic code block used in the demo's hero section. Pinned
// to TypeScript because the editor's own source code is TypeScript
// and the variety of syntax tokens (keywords, strings, comments,
// numbers, punctuation) makes the highlight theme pop.
const SHOWCASE_CODE = {
  lang: 'typescript',
  body: `// A tiny markdown chunker. Every token in this block is
// highlighted by a lazy-loaded CodeMirror grammar — open the
// "Sample" picker above and the TypeScript grammar only loads
// when a \`\`\`ts fence first appears on screen.
export function chunkMarkdown(input: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const nextBreak = input.indexOf('\\n\\n', cursor);
    if (nextBreak === -1) {
      blocks.push(input.slice(cursor));
      break;
    }
    blocks.push(input.slice(cursor, nextBreak));
    cursor = nextBreak + 2;
  }
  return blocks;
}`,
};

const CODE_SAMPLES = [
  {
    lang: 'typescript',
    body:
      'export function chunkMarkdown(input: string): string[] {\n' +
      '  const blocks: string[] = [];\n' +
      '  let cursor = 0;\n' +
      '  while (cursor < input.length) {\n' +
      '    const next = input.indexOf("\\n\\n", cursor);\n' +
      '    if (next === -1) { blocks.push(input.slice(cursor)); break; }\n' +
      '    blocks.push(input.slice(cursor, next));\n' +
      '    cursor = next + 2;\n' +
      '  }\n' +
      '  return blocks;\n' +
      '}',
  },
  {
    lang: 'rust',
    body:
      'pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {\n' +
      '    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();\n' +
      '    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();\n' +
      '    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();\n' +
      '    dot / (na * nb)\n' +
      '}',
  },
  {
    lang: 'python',
    body:
      'def embed_batch(texts: list[str]) -> list[list[float]]:\n' +
      '    response = client.embeddings.create(model="text-embedding-3-large", input=texts)\n' +
      '    return [r.embedding for r in response.data]',
  },
];

function words(rng: () => number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(WORDS[Math.floor(rng() * WORDS.length)]);
  }
  out[0] = out[0][0].toUpperCase() + out[0].slice(1);
  return out.join(' ');
}

function paragraph(rng: () => number): string {
  const sentenceCount = 3 + Math.floor(rng() * 4);
  const sentences: string[] = [];
  for (let i = 0; i < sentenceCount; i++) {
    const len = 8 + Math.floor(rng() * 14);
    sentences.push(words(rng, len) + '.');
  }
  return sentences.join(' ');
}

function list(rng: () => number): string {
  const n = 3 + Math.floor(rng() * 5);
  const items: string[] = [];
  for (let i = 0; i < n; i++) {
    items.push('- ' + words(rng, 4 + Math.floor(rng() * 10)) + '.');
    // Sprinkle in a nested sub-item once in a while so the harness has
    // realistic indentation to render.
    if (rng() < 0.35) {
      items.push('  - ' + words(rng, 3 + Math.floor(rng() * 6)) + '.');
      if (rng() < 0.3) {
        items.push('    - ' + words(rng, 3 + Math.floor(rng() * 5)) + '.');
      }
    }
  }
  return items.join('\n');
}

function taskList(rng: () => number): string {
  const n = 3 + Math.floor(rng() * 4);
  const items: string[] = [];
  for (let i = 0; i < n; i++) {
    const done = rng() < 0.4 ? 'x' : ' ';
    items.push(`- [${done}] ` + words(rng, 3 + Math.floor(rng() * 8)) + '.');
  }
  return items.join('\n');
}

function table(rng: () => number, imageless: boolean): string {
  const columns = 3 + Math.floor(rng() * 2);
  const rows = 2 + Math.floor(rng() * 3);
  const header = [] as string[];
  const divider = [] as string[];
  for (let c = 0; c < columns; c++) {
    header.push(words(rng, 1 + Math.floor(rng() * 2)));
    divider.push('---');
  }
  const lines: string[] = [
    '| ' + header.join(' | ') + ' |',
    '| ' + divider.join(' | ') + ' |',
  ];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < columns; c++) {
      // Every so often stick an inline image in a cell to exercise
      // image-within-table rendering. Skip entirely when the harness
      // is in imageless mode — the whole point of that mode is to
      // isolate image-related effects from the rest of the layout.
      if (!imageless && rng() < 0.15) {
        const seed = 2000 + Math.floor(rng() * 9000);
        cells.push(`![thumb](https://picsum.photos/seed/${seed}/80/60)`);
      } else {
        cells.push(words(rng, 1 + Math.floor(rng() * 3)));
      }
    }
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  return lines.join('\n');
}

function codeBlock(rng: () => number): string {
  const sample = CODE_SAMPLES[Math.floor(rng() * CODE_SAMPLES.length)];
  return '```' + sample.lang + '\n' + sample.body + '\n```';
}

function quote(rng: () => number): string {
  return '> ' + words(rng, 14 + Math.floor(rng() * 20)) + '.';
}

function link(rng: () => number): string {
  return (
    words(rng, 6) +
    ' — see [' +
    words(rng, 3) +
    '](https://example.org/' +
    Math.floor(rng() * 100000).toString(16) +
    ') for more.'
  );
}

function imageBlock(rng: () => number): string {
  // picsum.photos is seeded and deterministic — same seed always
  // returns the same image — so the harness screenshot stays stable.
  const seed = 1000 + Math.floor(rng() * 9000);
  const w = 320 + Math.floor(rng() * 260);
  const h = 180 + Math.floor(rng() * 200);
  const alt = words(rng, 2 + Math.floor(rng() * 2));
  return `![${alt}](https://picsum.photos/seed/${seed}/${w}/${h})`;
}

// Generate a section: h2 + 3-6 blocks.
function section(
  rng: () => number,
  idx: number,
  imageless: boolean,
  includeTables: boolean,
  includeLists: boolean,
  includeCodeBlocks: boolean,
): string {
  const title = words(rng, 3 + Math.floor(rng() * 4));
  const parts: string[] = [`## ${idx}. ${title}`];
  const blockCount = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < blockCount; i++) {
    const pick = rng();
    if (pick < 0.42) parts.push(paragraph(rng));
    // Each toggled-off slot redirects to a paragraph so overall
    // block density stays comparable between variants — keeps
    // scroll measurements from being biased by a shorter doc.
    else if (pick < 0.58)
      parts.push(includeLists ? list(rng) : paragraph(rng));
    else if (pick < 0.70)
      parts.push(includeLists ? taskList(rng) : paragraph(rng));
    else if (pick < 0.80)
      parts.push(includeTables ? table(rng, imageless) : paragraph(rng));
    else if (pick < 0.90)
      parts.push(includeCodeBlocks ? codeBlock(rng) : paragraph(rng));
    else if (pick < 0.96) parts.push(quote(rng));
    else parts.push(link(rng));
  }
  return parts.join('\n\n');
}

export type SampleSize = '1 page' | '10 pages' | '100 pages' | '500 pages' | '1000 pages';

const SECTIONS_PER_SIZE: Record<SampleSize, number> = {
  '1 page': 1,
  '10 pages': 10,
  '100 pages': 100,
  '500 pages': 500,
  '1000 pages': 1000,
};

export const SAMPLE_SIZES: SampleSize[] = [
  '1 page',
  '10 pages',
  '100 pages',
  '500 pages',
  '1000 pages',
];

export type SampleMode = 'with images' | 'imageless';

export const SAMPLE_MODES: SampleMode[] = ['with images', 'imageless'];

export type SeparatorsMode = 'with separators' | 'no separators';

export const SEPARATORS_MODES: SeparatorsMode[] = [
  'with separators',
  'no separators',
];

export type TablesMode = 'with tables' | 'no tables';

export const TABLES_MODES: TablesMode[] = ['with tables', 'no tables'];

export type ListsMode = 'with lists' | 'no lists';

export const LISTS_MODES: ListsMode[] = ['with lists', 'no lists'];

export type CodeBlocksMode = 'with code blocks' | 'no code blocks';

export const CODE_BLOCKS_MODES: CodeBlocksMode[] = [
  'with code blocks',
  'no code blocks',
];

// Cache so flipping between options doesn't re-pay the generation
// cost. Keyed on the full tuple because any of those changes the
// document shape.
const cache = new Map<string, string>();

function cacheKey(
  mode: SampleMode,
  separators: SeparatorsMode,
  tables: TablesMode,
  lists: ListsMode,
  codeBlocks: CodeBlocksMode,
  size: SampleSize,
): string {
  return `${mode}|${separators}|${tables}|${lists}|${codeBlocks}|${size}`;
}

export interface SampleOptions {
  mode?: SampleMode;
  separators?: SeparatorsMode;
  tables?: TablesMode;
  lists?: ListsMode;
  codeBlocks?: CodeBlocksMode;
}

export function generateSampleMarkdown(
  size: SampleSize,
  opts: SampleOptions = {},
): string {
  const mode = opts.mode ?? 'with images';
  const separators = opts.separators ?? 'with separators';
  const tables = opts.tables ?? 'with tables';
  const lists = opts.lists ?? 'with lists';
  const codeBlocks = opts.codeBlocks ?? 'with code blocks';
  const key = cacheKey(mode, separators, tables, lists, codeBlocks, size);
  const cached = cache.get(key);
  if (cached) return cached;

  const imageless = mode === 'imageless';
  const includeSeparators = separators === 'with separators';
  const includeTables = tables === 'with tables';
  const includeLists = lists === 'with lists';
  const includeCodeBlocks = codeBlocks === 'with code blocks';
  // Separate the seed per mode so the variants don't just look like
  // the same doc with some blocks snipped — the block mix is
  // re-rolled under each combo, giving a cleaner test surface.
  const seed =
    0xa70c1c ^
    SECTIONS_PER_SIZE[size] ^
    (imageless ? 0xb00b1e5 : 0) ^
    (includeSeparators ? 0 : 0x5eba571) ^
    (includeTables ? 0 : 0x7ab1e5) ^
    (includeLists ? 0 : 0x1157100) ^
    (includeCodeBlocks ? 0 : 0xc0de100);
  const rng = mulberry32(seed);

  const sections: string[] = [
    `# Atomic Editor`,
    `_CodeMirror 6 markdown editor with Obsidian-style inline live preview — WYSIWYG tables, syntax-highlighted code, interactive checkboxes, and cursor-scoped link unfold. Showing a ${size} sample._`,
    // Hero section — the three features that make users go "oh nice"
    // on first load. Deterministic content so the first-visit
    // impression is stable across reloads; random / varied content
    // for the section loop below.
    '## Try it',
  ];
  // 1. Fenced code block — shows per-grammar syntax highlighting.
  if (includeCodeBlocks) {
    sections.push(
      'Fenced code blocks pick up per-language syntax highlighting. The grammar loads lazily — only fences you actually open hit the wire:',
      '```' + SHOWCASE_CODE.lang + '\n' + SHOWCASE_CODE.body + '\n```',
    );
  }
  // 2. WYSIWYG table with inline markdown rendering inside cells.
  if (includeTables) {
    sections.push(
      'Tables render WYSIWYG. Click a cell to edit in place — inline markdown inside cells reveals its delimiters only when your cursor enters:',
      // Deterministic inline-marks table so probes can target a known
      // bold / italic / strike / link cell. First row is the baseline
      // (probes target row 0); subsequent rows add variety so every
      // supported combination appears at a glance — delimiter
      // variants, nesting, escapes, and cases that should
      // deliberately NOT decorate.
      [
        '| Plain | Bold | Italic | Strike | Link |',
        '|---|---|---|---|---|',
        '| plain text | **bold text** | *italic text* | ~~struck text~~ | [example](https://example.org) |',
        '| alt delim | __also bold__ | _also italic_ | ~~gone gone~~ | [github](https://github.com) |',
        '| nesting | **bold with _italic_ inside** | *italic with **bold** inside* | ~~strike with **bold**~~ | [text **bold** here](https://example.org) |',
        '| escapes | \\*literal stars\\* | \\_literal underscores\\_ | \\~\\~not strike\\~\\~ | \\[not a link\\] |',
        '| non-matches | snake_case_var | ident_with_underscores | `code stays raw` | https://example.org raw url |',
      ].join('\n'),
    );
  }
  // 3. Interactive task list — invites the user to actually click
  // something and feel the editor respond.
  if (includeLists) {
    sections.push(
      'Task lists are real checkboxes — click any of them to toggle. Pressing Enter on a task continues the list; Enter on an empty item dedents.',
      [
        '- [ ] Click me to toggle',
        '- [x] This one is already done',
        '- [ ] Tap at the end of this line and press Enter to continue the list',
      ].join('\n'),
    );
  }
  // Secondary section — a deliberate "read the prose" zone after
  // the hero trio. Sets context for what the editor can do with
  // ordinary text: headings, emphasis, escapes, collapsed links.
  sections.push('## And the usual markdown', paragraph(rng));
  if (includeSeparators) sections.push('---');
  if (includeLists) sections.push(list(rng));
  if (!imageless) {
    // Seeded picsum image — deterministic (same seed → same image
    // bytes) so the image-block widget, screenshots, and scroll
    // measurements stay stable across runs. Omitted in imageless
    // mode to isolate image-independent layout / scroll behavior.
    sections.push(imageBlock(rng));
  }
  sections.push(
    quote(rng),
    // Backslash-escape sample — RSS-to-markdown converters over-escape
    // punctuation. Readers should see plain text on inactive lines;
    // focusing the line reveals the raw escapes.
    'Escapes like domain\\.com and 3\\.14 should render clean until focused\\.',
    // Deterministic link line so probes have a stable target. Rendered
    // as `A link to example for reference.` on inactive cursor; clicking
    // inside the link reveals `[example](https://example.org)`.
    'A link to [example](https://example.org) for reference.',
  );
  for (let i = 1; i <= SECTIONS_PER_SIZE[size]; i++) {
    // When separators are on, drop an HR between every section so a
    // long scroll runs past many of them — makes it easy to feel
    // whether iOS momentum halts correlate with HR boundaries.
    if (includeSeparators && i > 1) sections.push('---');
    sections.push(
      section(rng, i, imageless, includeTables, includeLists, includeCodeBlocks),
    );
  }
  const doc = sections.join('\n\n') + '\n';
  cache.set(key, doc);
  return doc;
}

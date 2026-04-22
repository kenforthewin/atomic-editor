#!/usr/bin/env node

/**
 * Playwright-driven probes for the demo page.
 *
 * Measures what the eye can't easily quantify: cumulative layout shift
 * during idle, cursor movement, typing, and scroll, plus whether a
 * drag-selection still produces the raw markdown on copy.
 *
 * Usage:
 *   node scripts/test-editor.mjs               # auto-start dev server
 *   node scripts/test-editor.mjs --headed      # see the browser
 *   node scripts/test-editor.mjs --skip-dev    # assume :5173 is up
 *   HARNESS_URL=http://foo:5173 node scripts/test-editor.mjs
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const headed = args.has('--headed');
const skipDev = args.has('--skip-dev');
const base = process.env.HARNESS_URL || 'http://localhost:5173';

const SCREENSHOT_DIR = path.join(repoRoot, '.harness-screenshots');
rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ---------- dev server lifecycle ----------

async function isServerUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isServerUp(base)) {
    log('info', `using existing dev server at ${base}`);
    return null;
  }
  if (skipDev) {
    throw new Error(`dev server not reachable at ${base} and --skip-dev was set`);
  }
  log('info', 'starting vite dev server…');
  const proc = spawn('npm', ['run', 'dev'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    if (await isServerUp(base)) {
      log('info', `dev server ready (${Math.round((Date.now() - start) / 100) / 10}s)`);
      return proc;
    }
    await sleep(400);
  }
  proc.kill('SIGTERM');
  throw new Error(`dev server did not respond on ${base} within 60s`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- logging ----------

const results = [];
const COLORS = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
function color(c, s) {
  return process.stdout.isTTY ? `${COLORS[c]}${s}${COLORS.reset}` : s;
}

function log(level, msg) {
  const tag = level === 'fail' ? color('red', 'FAIL') : level === 'warn' ? color('yellow', 'WARN') : level === 'ok' ? color('green', ' OK ') : color('cyan', 'INFO');
  console.log(`[${tag}] ${msg}`);
}

function record(name, status, detail) {
  results.push({ name, status, detail });
  log(status === 'pass' ? 'ok' : status === 'warn' ? 'warn' : status === 'fail' ? 'fail' : 'info', `${name.padEnd(38)} ${detail}`);
}

// ---------- CLS measurement helpers ----------

const BEGIN_CLS_WINDOW = /* js */ `
  (() => {
    window.__clsEntries = [];
    window.__clsObserver?.disconnect();
    window.__clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__clsEntries.push({
          value: entry.value,
          hadRecentInput: entry.hadRecentInput,
          startTime: entry.startTime,
          sources: (entry.sources || []).map(s => ({
            node: s.node?.nodeName || null,
            className: s.node?.className || null,
            previousRect: { x: s.previousRect.x, y: s.previousRect.y, w: s.previousRect.width, h: s.previousRect.height },
            currentRect: { x: s.currentRect.x, y: s.currentRect.y, w: s.currentRect.width, h: s.currentRect.height },
          })),
        });
      }
    });
    window.__clsObserver.observe({ type: 'layout-shift', buffered: false });
  })();
`;

const END_CLS_WINDOW = /* js */ `
  (() => {
    window.__clsObserver?.disconnect();
    const entries = window.__clsEntries || [];
    window.__clsEntries = [];
    const total = entries.reduce((a, e) => a + e.value, 0);
    return { total, count: entries.length, entries };
  })();
`;

async function measureCLS(page, durationMs, action) {
  await page.evaluate(BEGIN_CLS_WINDOW);
  if (action) await action();
  await page.waitForTimeout(durationMs);
  return page.evaluate(END_CLS_WINDOW);
}

function topShiftSources(entries, n) {
  const byNode = new Map();
  for (const e of entries) {
    for (const s of e.sources || []) {
      const key = `${s.node}.${(s.className || '').toString().split(' ').slice(0, 2).join('.')}`;
      byNode.set(key, (byNode.get(key) || 0) + e.value / Math.max(1, e.sources.length));
    }
  }
  return [...byNode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}(${v.toFixed(3)})`)
    .join(', ');
}

// ---------- probes ----------

async function probeIdle(page) {
  await page.waitForSelector('.cm-editor');
  await page.waitForTimeout(300);
  const cls = await measureCLS(page, 1500);
  const status = cls.total < 0.05 ? 'pass' : cls.total < 0.2 ? 'warn' : 'fail';
  record('idle CLS (1.5s post-mount)', status, `total=${cls.total.toFixed(3)} shifts=${cls.count}`);
  return cls;
}

async function probeCursorPingPong(page) {
  // Bounce the cursor between an H2 and a plain paragraph line a few
  // times. Each cursor move swaps which line is "active" and triggers
  // a decoration rebuild; if the swap changes heights, CLS spikes.
  //
  // Earlier probes may have scrolled the viewport far from the top
  // (task-list probe ctrl+End's to doc end). CM6 virtualizes, so lines
  // outside the viewport aren't in the DOM and locators can't find
  // them. Reset scroll before we target.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(250);

  const h2 = page.locator('.cm-line.cm-atomic-h2').first();
  const para = page.locator('.cm-line:not([class*="cm-atomic"])').nth(4);
  if ((await h2.count()) === 0 || (await para.count()) === 0) {
    record('cursor ping-pong CLS', 'fail', 'missing target lines');
    return null;
  }
  const h2box = await h2.boundingBox();
  const pbox = await para.boundingBox();
  if (!h2box || !pbox) {
    record('cursor ping-pong CLS', 'fail', 'no bbox');
    return null;
  }
  const cls = await measureCLS(page, 2500, async () => {
    for (let i = 0; i < 5; i++) {
      await page.mouse.click(h2box.x + 40, h2box.y + h2box.height / 2);
      await page.waitForTimeout(160);
      await page.mouse.click(pbox.x + 40, pbox.y + pbox.height / 2);
      await page.waitForTimeout(160);
    }
  });
  const status = cls.total < 0.05 ? 'pass' : cls.total < 0.2 ? 'warn' : 'fail';
  const topSrc = topShiftSources(cls.entries, 4);
  record(
    'ping-pong CLS (10 moves)',
    status,
    `total=${cls.total.toFixed(3)} shifts=${cls.count}${topSrc ? ` sources=${topSrc}` : ''}`,
  );
  return cls;
}

async function probeColdLoadH1Hidden(page) {
  // On mount with no focus, the H1 should read as rendered (no `# `
  // prefix visible). CM6's default selection is cursor(0), which
  // would otherwise make the first line "active" even before the
  // user touches the editor.
  const h1 = page.locator('.cm-line.cm-atomic-h1').first();
  if ((await h1.count()) === 0) {
    record('cold load: H1 syntax hidden', 'fail', 'no H1 line');
    return;
  }
  const text = (await h1.textContent()) ?? '';
  const hidden = !text.trim().startsWith('#');
  record(
    'cold load: H1 syntax hidden',
    hidden ? 'pass' : 'fail',
    `text=${JSON.stringify(text.slice(0, 40))}`,
  );
}

async function probeClickFreeze(page) {
  // Behavior under test: when you click a heading line, the `# ` prefix
  // should NOT appear immediately (that's what shifts layout under the
  // cursor and turns clicks into micro-drags). It should appear a beat
  // after the mouse is released, once the freeze tail expires.
  const h2 = page.locator('.cm-line.cm-atomic-h2').first();
  if ((await h2.count()) === 0) {
    record('click freeze: heading stays rendered mid-click', 'fail', 'no H2 line');
    return;
  }
  const box = await h2.boundingBox();
  if (!box) {
    record('click freeze: heading stays rendered mid-click', 'fail', 'no bbox');
    return;
  }

  // Measure the line text before the click — we expect `## ` to be
  // hidden, so the text starts with the heading's first non-syntax
  // character.
  const textBefore = (await h2.textContent())?.trim() ?? '';

  // Let any in-flight work from the prior probe settle before we try
  // to race the freeze mechanic. Without this buffer the probe starts
  // mid-dispatch on slow CI runners and the first-sample read catches
  // the pre-freeze reveal from a selection change still processing.
  await page.waitForTimeout(200);

  const clickX = box.x + Math.min(box.width / 3, 80);
  const clickY = box.y + box.height / 2;

  // Explicit down/up instead of page.mouse.click(): we want to hold
  // the pointer down and measure while the freeze is active, without
  // racing pointerup's FREEZE_TAIL_MS=100 release timer. Real user
  // clicks always span at least one frame between down and up, so
  // simulating a held press is closer to the intended UX anyway.
  await page.mouse.move(clickX, clickY);
  await page.mouse.down();

  // Sample the heading text several times across the held-pointer
  // window. The freeze effect dispatches synchronously in the
  // capture-phase pointerdown handler, so we should never observe a
  // "## " reveal during this window. Multiple samples catch both
  // fast-race regressions (reveal-then-hide inside a few ms) and
  // slow-settle bugs (wrong initial state). All samples must show
  // hidden syntax.
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const text = (await h2.textContent())?.trim() ?? '';
    samples.push(text);
    if (i < 4) await page.waitForTimeout(15);
  }
  await page.mouse.up();

  const stayedRendered = samples.every((s) => !/^##\s/.test(s));
  const textDuringFreeze = samples.find((s) => /^##\s/.test(s)) ?? samples[0];

  record(
    'click freeze: heading stays rendered mid-click',
    stayedRendered ? 'pass' : 'fail',
    `before="${textBefore.slice(0, 40)}" duringFreeze="${textDuringFreeze.slice(0, 40)}" samples=${samples.length}`,
  );

  // After the freeze tail (100ms from mouseup), syntax should reveal.
  await page.waitForTimeout(250);
  const textAfterFreeze = (await h2.textContent())?.trim() ?? '';
  const revealed = /^##\s/.test(textAfterFreeze);

  record(
    'click freeze: syntax revealed after tail',
    revealed ? 'pass' : 'fail',
    `afterFreeze="${textAfterFreeze.slice(0, 40)}"`,
  );

  // Verify the click didn't turn into a micro-drag — selection should
  // be a collapsed cursor, not a range.
  const selLen = await page.evaluate(() => window.getSelection()?.toString().length ?? 0);
  record(
    'click freeze: no accidental selection',
    selLen === 0 ? 'pass' : 'fail',
    `selectionLen=${selLen}`,
  );
}

async function probeFenceVisibility(page) {
  // When any line inside a fenced code block is active, the ``` fences
  // (and language info) should stay visible so the user keeps context
  // while editing code. Without the FencedCode expansion the fence
  // lines would be considered inactive and their CodeMark/CodeInfo
  // tokens would be hidden.

  // Image widgets in the showcase reserve real height via
  // `estimatedHeight`, which can push the code block below the
  // initial viewport. Scroll down until a fenced-code line renders.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(150);
  for (let step = 0; step < 10; step++) {
    const visible = await page.locator('.cm-line.cm-atomic-fenced-code').count();
    if (visible >= 3) break;
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop += 400;
    });
    await page.waitForTimeout(120);
  }

  const codeLines = page.locator('.cm-line.cm-atomic-fenced-code');
  const count = await codeLines.count();
  if (count < 3) {
    record('fence stays visible while editing code', 'fail', `only ${count} fenced-code lines`);
    return;
  }

  // Opening fence is the first such line. Interior code is somewhere
  // between the open and close — pick the second line which is
  // immediately after the opening fence.
  const openFence = codeLines.nth(0);
  const interior = codeLines.nth(1);
  const interiorBox = await interior.boundingBox();
  if (!interiorBox) {
    record('fence stays visible while editing code', 'fail', 'no interior bbox');
    return;
  }

  // Click inside the interior code line to make it active.
  await page.mouse.click(interiorBox.x + 30, interiorBox.y + interiorBox.height / 2);
  // Past the freeze tail so the decoration rebuild has applied.
  await page.waitForTimeout(200);

  const fenceText = (await openFence.textContent())?.trim() ?? '';
  const visible = /^```/.test(fenceText);
  record(
    'fence stays visible while editing code',
    visible ? 'pass' : 'fail',
    `fenceLine="${fenceText.slice(0, 40)}"`,
  );
}

async function runNewBulletListScenario(page, label, setup, screenshotName) {
  const uniq = `ITEM_${Date.now().toString(36).slice(-4)}`;
  await setup(page, uniq);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, screenshotName), fullPage: false });

  const itemA = page.locator('.cm-line', { hasText: `${uniq}A` }).first();
  const itemB = page.locator('.cm-line', { hasText: `${uniq}B` }).first();
  if ((await itemA.count()) === 0 || (await itemB.count()) === 0) {
    record(`list gap [${label}]`, 'fail', 'items not found');
    return;
  }
  const aBox = await itemA.boundingBox();
  const bBox = await itemB.boundingBox();
  if (!aBox || !bBox) {
    record(`list gap [${label}]`, 'fail', 'no bbox');
    return;
  }
  const gap = bBox.y - (aBox.y + aBox.height);
  const status = gap < 8 ? 'pass' : gap < 40 ? 'warn' : 'fail';

  // Collect every .cm-line that sits between itemA and itemB vertically
  // and dump their text so we can see whether an extra blank line
  // exists in the DOM (and whether it's in the doc or only in the
  // rendered layout).
  const between = await page.evaluate(
    ({ yA, yB }) => {
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      return lines
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            mid: r.top + r.height / 2,
            text: el.textContent ?? '',
            cls: el.className,
          };
        })
        .filter((info) => info.mid > yA && info.mid < yB)
        .slice(0, 5);
    },
    { yA: aBox.y + aBox.height / 2, yB: bBox.y + bBox.height / 2 },
  );
  const betweenStr = between.map((b) => `"${b.text.slice(0, 30)}"[${b.cls.replace(/cm-/g, '')}]`).join(' | ');

  // Dump a wide window of .cm-line divs around the typed items so we
  // can see the full line structure the editor produced.
  const docExcerpt = await page.evaluate((marker) => {
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    const idx = lines.findIndex((el) => (el.textContent || '').includes(marker + 'A'));
    if (idx < 0) return null;
    const slice = lines.slice(Math.max(0, idx - 5), idx + 5);
    return slice
      .map((el) => `[${(el.textContent || '').slice(0, 30)}]`)
      .join(' / ');
  }, uniq);

  record(
    `list gap [${label}]`,
    status,
    `gap=${gap.toFixed(1)}px between=${betweenStr || '(none)'} doc="${docExcerpt}"`,
  );
}

async function probeNewBulletList(page) {
  // Scenario A: after a plain paragraph, two blank lines, then list.
  // Reset scroll first — earlier probes (fence-visibility) scroll
  // down, and the .nth(3) plain-line target is viewport-relative.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);

  await runNewBulletListScenario(
    page,
    'after para +2 blanks',
    async (p, uniq) => {
      const para = p.locator('.cm-line:not([class*="cm-atomic"])').nth(3);
      const box = await para.boundingBox();
      await p.mouse.click(box.x + 40, box.y + box.height / 2);
      await p.waitForTimeout(180);
      await p.keyboard.press('End');
      await p.keyboard.press('Enter');
      await p.keyboard.press('Enter');
      await p.keyboard.type(`- ${uniq}A`);
      await p.keyboard.press('Enter');
      await p.keyboard.type(`${uniq}B`);
    },
    '20-list-after-para.png',
  );

  // Scenario B: immediately after a heading, single Enter, then list.
  // (Obsidian and GFM behave differently about tight/loose lists here.)
  await runNewBulletListScenario(
    page,
    'after h2 +1 blank',
    async (p, uniq) => {
      // Reset to the top so the showcase H2 is reliably mounted.
      // Originally this targeted nth(1) to "avoid the first", but
      // as the showcase grew (tables, images, HR) section 1's H2
      // moved outside CM6's initial viewport — the nth(0) showcase
      // H2 is always present at the top.
      await p.locator('.cm-scroller').evaluate((el) => { el.scrollTop = 0; });
      await p.waitForTimeout(200);
      const h2 = p.locator('.cm-line.cm-atomic-h2').first();
      const box = await h2.boundingBox();
      await p.mouse.click(box.x + 40, box.y + box.height / 2);
      await p.waitForTimeout(180);
      await p.keyboard.press('End');
      await p.keyboard.press('Enter');
      await p.keyboard.press('Enter');
      await p.keyboard.type(`- ${uniq}A`);
      await p.keyboard.press('Enter');
      await p.keyboard.type(`${uniq}B`);
    },
    '21-list-after-h2.png',
  );

}

async function probeNestedListExit(page) {
  // Regression guard: pressing Enter on an empty nested list item
  // should drop one level of indent per press, ending with a clean
  // unindented cursor — no orphan whitespace from the item's indent.
  const content = page.locator('.cm-content').first();
  await content.click();
  await page.waitForTimeout(180);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  const uniq = `NEST_${Date.now().toString(36).slice(-4)}`;
  // Build a two-level list: `- outer` + nested `  - inner`.
  await page.keyboard.type(`- outer-${uniq}`);
  await page.keyboard.press('Enter');
  // `  - ` prefix — use the auto-continuation from Enter on outer,
  // then indent manually by typing two spaces + the marker. Explicit
  // control makes the test less brittle to auto-indent behavior.
  await page.keyboard.type(`  - inner-${uniq}`);
  await page.waitForTimeout(200);

  // Enter 1: continues with `  - ` (empty nested item).
  await page.keyboard.press('Enter');
  // Enter 2: pop to outer level → line becomes `- `.
  await page.keyboard.press('Enter');
  // Enter 3: top-level empty → line fully cleared.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);

  // Read the line text where the cursor is now. The line should be
  // empty (no leading whitespace). Playwright's selection API gives
  // us the DOM anchor; walk up to the containing .cm-line.
  const exitLineText = await page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.anchorNode;
    while (node && !(node instanceof Element && node.classList.contains('cm-line'))) {
      node = node.parentNode;
    }
    return node ? node.textContent ?? '' : null;
  });

  const status =
    exitLineText !== null && !/^\s/.test(exitLineText) ? 'pass' : 'fail';
  record(
    'nested list: clean exit after 3 Enters',
    status,
    `exit line text = ${JSON.stringify(exitLineText)}`,
  );
}

async function probeCloseBrackets(page) {
  // Type an opening bracket — the editor should auto-insert the
  // closer and leave the caret between them. Typing content then
  // shows the bracket pair surrounding it.
  const content = page.locator('.cm-content').first();
  await content.click();
  await page.waitForTimeout(180);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  async function checkPair(opener, closer, label) {
    const uniq = `${label}${Date.now().toString(36).slice(-4)}`;
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(opener);
    await page.keyboard.type(uniq);
    await page.waitForTimeout(120);
    const lineText = await page.evaluate((marker) => {
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      const hit = lines.find((el) => (el.textContent || '').includes(marker));
      return hit ? (hit.textContent || '') : null;
    }, uniq);
    const ok = lineText?.includes(`${opener}${uniq}${closer}`) ?? false;
    record(
      `closeBrackets: \`${opener}\` auto-pairs`,
      ok ? 'pass' : 'fail',
      `line=${JSON.stringify(lineText?.slice(0, 60))}`,
    );
  }

  await checkPair('[', ']', 'br');
  await checkPair('*', '*', 'em');
  await checkPair('_', '_', 'un');
  await checkPair('`', '`', 'bt');

  // Bold promote: typing `*` into an empty `*|*` pair should extend
  // to `**|**` rather than stepping through. Then content + a single
  // `*` should step through the inner asterisk, yielding `**foo*|*`.
  const boldMarker = `bd${Date.now().toString(36).slice(-4)}`;
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('**'); // extend on second `*` → `**|**`
  await page.keyboard.type(boldMarker);
  await page.waitForTimeout(120);
  const boldLine = await page.evaluate((marker) => {
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    const hit = lines.find((el) => (el.textContent || '').includes(marker));
    return hit ? (hit.textContent || '') : null;
  }, boldMarker);
  const boldOk = boldLine?.includes(`**${boldMarker}**`) ?? false;
  record(
    'closeBrackets: `**` promotes to double pair',
    boldOk ? 'pass' : 'fail',
    `line=${JSON.stringify(boldLine?.slice(0, 60))}`,
  );
}

async function probeTableFromMarkdown(page) {
  // Regression guard for "type raw table markdown → widget appears".
  // Scroll to top, click a plain paragraph line, navigate to doc end,
  // type the markdown, and verify a new table widget materialized.
  await page.locator('.cm-scroller').evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  const plain = page.locator('.cm-line:not([class*="cm-atomic"])').first();
  const box = await plain.boundingBox();
  if (!box) {
    record('table: instantiate from markdown', 'fail', 'no plain line to focus');
    return;
  }
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  await page.waitForTimeout(180);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  const marker = `NEWTBL_${Date.now().toString(36).slice(-4)}`;
  // Keyboard.type sends literal characters; `|` and `-` type as-is.
  // Avoid closeBrackets interference: `|` isn't in the bracket set;
  // `-` similarly won't auto-pair. But our bullet-continuation Enter
  // might activate on the `-` row — type the whole table first, then
  // Enter at the end to close it.
  await page.keyboard.type(`| Col | ${marker} |`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('| --- | --- |');
  await page.keyboard.press('Enter');
  await page.keyboard.type('| a | b |');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);

  // Query all table widgets and find the one whose header contains our
  // unique marker.
  const found = await page.evaluate((m) => {
    const widgets = Array.from(document.querySelectorAll('.cm-atomic-table'));
    for (const w of widgets) {
      const text = w.textContent || '';
      if (text.includes(m)) return true;
    }
    return false;
  }, marker);

  record(
    'table: instantiate from markdown',
    found ? 'pass' : 'fail',
    `marker ${marker} rendered as widget? ${found}`,
  );
}

async function probeTableWidget(page) {
  // The showcase section contains a markdown table; it should render
  // as a `.cm-atomic-table` block widget with at least one `<table>`
  // inside, and cells should be contenteditable.
  await page.locator('.cm-scroller').evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  // Scroll a bit to get the table into viewport
  await page.locator('.cm-scroller').evaluate((el) => { el.scrollTop = 500; });
  await page.waitForTimeout(400);

  const info = await page.evaluate(() => {
    const wrap = document.querySelector('.cm-atomic-table');
    if (!wrap) return { found: false };
    const table = wrap.querySelector('table');
    const headerCells = table?.querySelectorAll('thead th') ?? [];
    const bodyRows = table?.querySelectorAll('tbody tr') ?? [];
    const firstCell = headerCells[0];
    // Cells themselves aren't contenteditable — the inner source
    // element is. This keeps the image preview strictly visual.
    const source = firstCell?.querySelector('.cm-atomic-table-cell-source');
    return {
      found: true,
      cols: headerCells.length,
      rows: bodyRows.length,
      cellEditable: source?.contentEditable === 'true',
      firstHeader: source?.textContent ?? '',
    };
  });

  if (!info.found) {
    record('table widget: rendered', 'fail', 'no .cm-atomic-table');
    return;
  }
  record(
    'table widget: rendered',
    info.cols > 0 && info.rows > 0 && info.cellEditable ? 'pass' : 'fail',
    `${info.cols} cols × ${info.rows} rows, firstHeader=${JSON.stringify(info.firstHeader)}, editable=${info.cellEditable}`,
  );
}

async function probeTableCellMarkdown(page) {
  // The showcase includes a deterministic inline-marks table with
  // columns: Plain | Bold | Italic | Strike | Link.
  // Body row: plain text | **bold text** | *italic text* | ~~struck text~~ | [example](https://example.org)
  //
  // Each mark should decorate into its matching `.cm-atomic-*` span
  // inside the cell's source element. On focus, the cell should swap
  // to plain text (no decoration spans) so typing stays clean; on
  // blur, decorations re-apply.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  for (let step = 0; step < 8; step++) {
    const present = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.cm-atomic-table')).some((w) =>
        (w.textContent || '').includes('struck text'),
      ),
    );
    if (present) break;
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop += 200;
    });
    await page.waitForTimeout(120);
  }

  const shape = await page.evaluate(() => {
    const wrap = Array.from(document.querySelectorAll('.cm-atomic-table')).find(
      (w) => (w.textContent || '').includes('struck text'),
    );
    if (!wrap) return { found: false };
    const bodyRow = wrap.querySelector('tbody tr');
    if (!bodyRow) return { found: false };
    const cells = Array.from(bodyRow.querySelectorAll('td'));
    // Expect 5 cells (Plain, Bold, Italic, Strike, Link).
    const get = (cell, sel) => (cell ? cell.querySelector(sel) !== null : false);
    const boldCell = cells[1];
    const italicCell = cells[2];
    const strikeCell = cells[3];
    const linkCell = cells[4];
    return {
      found: true,
      hasBold: get(boldCell, '.cm-atomic-strong'),
      boldText: boldCell?.querySelector('.cm-atomic-strong')?.textContent || '',
      hasItalic: get(italicCell, '.cm-atomic-em'),
      italicText: italicCell?.querySelector('.cm-atomic-em')?.textContent || '',
      hasStrike: get(strikeCell, '.cm-atomic-strike'),
      strikeText: strikeCell?.querySelector('.cm-atomic-strike')?.textContent || '',
      hasLink: get(linkCell, '.cm-atomic-link'),
      linkText: linkCell?.querySelector('.cm-atomic-link')?.textContent || '',
      linkUrl: linkCell?.querySelector('.cm-atomic-link-wrap')?.dataset.url || '',
      boldCellText: boldCell?.textContent || '',
    };
  });

  if (!shape.found) {
    record('cell markdown: table present', 'fail', 'inline-marks table not rendered');
    return;
  }
  record(
    'cell markdown: bold decorates',
    shape.hasBold && shape.boldText === 'bold text' ? 'pass' : 'fail',
    `hasBold=${shape.hasBold} text=${JSON.stringify(shape.boldText)}`,
  );
  record(
    'cell markdown: italic decorates',
    shape.hasItalic && shape.italicText === 'italic text' ? 'pass' : 'fail',
    `hasItalic=${shape.hasItalic} text=${JSON.stringify(shape.italicText)}`,
  );
  record(
    'cell markdown: strike decorates',
    shape.hasStrike && shape.strikeText === 'struck text' ? 'pass' : 'fail',
    `hasStrike=${shape.hasStrike} text=${JSON.stringify(shape.strikeText)}`,
  );
  record(
    'cell markdown: link decorates',
    shape.hasLink &&
      shape.linkText === 'example' &&
      shape.linkUrl === 'https://example.org'
      ? 'pass'
      : 'fail',
    `hasLink=${shape.hasLink} text=${JSON.stringify(shape.linkText)} url=${shape.linkUrl}`,
  );
  // textContent of the bold cell must equal its raw source so round-
  // trip is preserved — new inline-mark rendering can't silently
  // change what the outer source sees on re-serialize.
  record(
    'cell markdown: decorated textContent round-trips',
    shape.boldCellText === '**bold text**' ? 'pass' : 'fail',
    `cellTextContent=${JSON.stringify(shape.boldCellText)}`,
  );

  // Focus the bold cell and drop the caret inside the `.cm-atomic-
  // strong` content span. The strong wrap should get `.active` so
  // its `.cm-atomic-mark` delimiters reveal (display: inline via CSS).
  // All other cells in the table should remain without any `.active`.
  const focused = await page.evaluate(() => {
    const wrap = Array.from(document.querySelectorAll('.cm-atomic-table')).find(
      (w) => (w.textContent || '').includes('struck text'),
    );
    if (!wrap) return null;
    const boldCell = wrap.querySelectorAll('tbody tr')[0]?.querySelectorAll('td')[1];
    if (!boldCell) return null;
    const src = boldCell.querySelector('.cm-atomic-table-cell-source');
    const strong = boldCell.querySelector('.cm-atomic-strong');
    if (!src || !strong) return null;
    src.focus();
    // Place caret inside the strong span's content.
    const sel = window.getSelection();
    if (!sel) return null;
    const range = document.createRange();
    range.setStart(strong.firstChild ?? strong, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    // Selection changes don't fire a focus event on their own — drive
    // the update directly by dispatching a keyup (mirroring a real
    // arrow-key navigation). The keyup handler calls the tracker.
    src.dispatchEvent(new KeyboardEvent('keyup'));
    return new Promise((resolve) => {
      setTimeout(() => {
        const strongWrap = boldCell.querySelector('.cm-atomic-strong-wrap');
        resolve({
          wrapActive: strongWrap?.classList.contains('active') ?? false,
          otherWrapActiveCount: wrap.querySelectorAll(
            '.cm-atomic-em-wrap.active, .cm-atomic-strike-wrap.active, .cm-atomic-link-wrap.active',
          ).length,
        });
      }, 40);
    });
  });
  if (focused) {
    record(
      'cell markdown: caret in bold reveals its delimiters',
      focused.wrapActive && focused.otherWrapActiveCount === 0 ? 'pass' : 'fail',
      `wrapActive=${focused.wrapActive} otherActive=${focused.otherWrapActiveCount}`,
    );
  } else {
    record(
      'cell markdown: caret in bold reveals its delimiters',
      'fail',
      'bold cell / strong span not found',
    );
  }

  // Blur the focused cell: all mark wraps should drop `.active`, so
  // delimiters collapse back to their hidden resting state.
  const collapsed = await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    return new Promise((resolve) => {
      setTimeout(() => {
        const wrap = Array.from(document.querySelectorAll('.cm-atomic-table')).find(
          (w) => (w.textContent || '').includes('struck text'),
        );
        if (!wrap) return resolve(null);
        resolve({
          activeCount: wrap.querySelectorAll('.active').length,
        });
      }, 40);
    });
  });
  record(
    'cell markdown: blur collapses all delimiters',
    collapsed && collapsed.activeCount === 0 ? 'pass' : 'fail',
    `activeCount=${collapsed?.activeCount}`,
  );
}

async function probeHeadingClickTargets(page) {
  // Clicking in the visual "blank space" immediately above a heading
  // should land on the empty line above, not on the heading itself.
  // Prior padding-top values (0.4em–0.7em) made the heading's hit-box
  // extend into what looked like blank space. Regression guard: the
  // padding-top zone above a heading's text baseline must be small
  // enough that a click ~8px above the heading's top lands on the
  // preceding line, not on the heading.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  for (let step = 0; step < 12; step++) {
    const present = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.cm-line.cm-atomic-h2')).some(
        (el) => (el.textContent || '').includes('And the usual markdown'),
      ),
    );
    if (present) break;
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop += 200;
    });
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(200);

  const info = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    const h2Idx = lines.findIndex(
      (el) =>
        el.classList.contains('cm-atomic-h2') &&
        (el.textContent || '').includes('And the usual markdown'),
    );
    if (h2Idx < 1) return null;
    const h2 = lines[h2Idx];
    const r = h2.getBoundingClientRect();
    const cs = getComputedStyle(h2);
    return { top: r.top, paddingTop: parseFloat(cs.paddingTop) || 0 };
  });
  if (!info) {
    record('heading click: padding-top zone under 8px', 'fail', 'h2 not located');
    return;
  }
  record(
    'heading click: padding-top zone under 8px',
    info.paddingTop < 8 ? 'pass' : 'fail',
    `paddingTop=${info.paddingTop.toFixed(1)}px`,
  );

  // Click just above the heading's top edge — should land on the
  // empty separator line, not the heading.
  await page.mouse.click(300, Math.round(info.top - 4));
  await page.waitForTimeout(120);
  const landedAbove = await page.evaluate(() => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const el =
      node?.nodeType === 1
        ? /** @type {Element} */ (node).closest?.('.cm-line')
        : node?.parentElement?.closest?.('.cm-line');
    if (!el) return null;
    return {
      isHeading: el.classList.contains('cm-atomic-h2'),
      text: (el.textContent || '').slice(0, 40),
    };
  });
  record(
    'heading click: y above heading lands on preceding line',
    landedAbove && !landedAbove.isHeading ? 'pass' : 'fail',
    `isHeading=${landedAbove?.isHeading} text=${JSON.stringify(landedAbove?.text ?? '')}`,
  );
}

async function probeHorizontalRule(page) {
  // The showcase section includes a `---` line. On inactive (cold)
  // state it should be classed as `cm-atomic-hr` so the CSS rule
  // renders, and the raw characters should be hidden.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);

  // Scroll until the HR is in the rendered viewport (CM6 virtualizes,
  // so elements outside the viewport don't exist in the DOM).
  for (let step = 0; step < 12; step++) {
    const present = await page.evaluate(
      () => document.querySelector('.cm-line.cm-atomic-hr') !== null,
    );
    if (present) break;
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop += 200;
    });
    await page.waitForTimeout(120);
  }

  const info = await page.evaluate(() => {
    const el = document.querySelector('.cm-line.cm-atomic-hr');
    if (!el) return { found: false };
    return {
      found: true,
      text: el.textContent || '',
    };
  });

  if (!info.found) {
    record('horizontal rule: line class applied', 'fail', 'no .cm-atomic-hr');
    return;
  }
  const hidden = info.text.trim().length === 0;
  record(
    'horizontal rule: line class applied',
    'pass',
    `text=${JSON.stringify(info.text)}`,
  );
  record(
    'horizontal rule: raw chars hidden',
    hidden ? 'pass' : 'fail',
    `trimmed text length = ${info.text.trim().length}`,
  );
}

async function probeBackslashEscape(page) {
  // The showcase includes `domain\.com` style escapes. On an inactive
  // line the backslashes should be hidden, so the visible text reads
  // `domain.com` rather than `domain\.com`. Focusing the line should
  // reveal the raw source again.
  //
  // The sample line sits late in the showcase (after images and a
  // code block), so CM6 virtualization may leave it outside the DOM
  // at scrollTop=0. Scroll down until a line matching the marker
  // word is rendered, giving the probe a stable target regardless of
  // upstream showcase length changes.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(150);
  for (let step = 0; step < 12; step++) {
    const present = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.cm-line')).some((el) =>
        (el.textContent || '').includes('Escapes like'),
      ),
    );
    if (present) break;
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop += 200;
    });
    await page.waitForTimeout(120);
  }

  const inactive = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    const line = lines.find((el) => (el.textContent || '').includes('Escapes like'));
    return line ? (line.textContent || '') : null;
  });

  if (!inactive) {
    record('escape: inactive line drops backslashes', 'fail', 'sample line not rendered');
    return;
  }
  const hidesBackslash =
    !inactive.includes('\\.') && inactive.includes('domain.com') && inactive.includes('3.14');
  record(
    'escape: inactive line drops backslashes',
    hidesBackslash ? 'pass' : 'fail',
    `text=${JSON.stringify(inactive.slice(0, 80))}`,
  );

  // Click the line to activate it, then confirm the raw `\.` returns.
  // Use locator.click — auto-scrolls the element into view and does
  // the actionability checks, more reliable than computing the box
  // and calling page.mouse.click at those coords (which can miss
  // when the target lands at a viewport edge).
  const sampleLine = page
    .locator('.cm-line', { hasText: 'Escapes like' })
    .first();
  await sampleLine.click({ position: { x: 20, y: 4 } });
  await page.waitForTimeout(200);

  const active = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    const line = lines.find((el) => (el.textContent || '').includes('Escapes like'));
    return line ? (line.textContent || '') : null;
  });
  record(
    'escape: active line reveals backslashes',
    active && active.includes('\\.') ? 'pass' : 'fail',
    `text=${JSON.stringify((active || '').slice(0, 80))}`,
  );
}

async function probeLinkScope(page) {
  // Behavior under test: a link's raw `[text](url)` syntax should only
  // reveal when the cursor is INSIDE the link itself — not merely on
  // the same line. Obsidian-style link unfold. Contrasts with emphasis
  // and headings, which still reveal line-wide.
  //
  // Sample line (in the showcase):
  //   `A link to [example](https://example.org) for reference.`

  // Reset scroll so we don't land on a link from a later section.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(120);

  // The deterministic showcase link line sits after the escapes line.
  // Scroll until it's in the DOM.
  for (let step = 0; step < 12; step++) {
    const present = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.cm-line')).some((el) =>
        (el.textContent || '').includes('A link to'),
      ),
    );
    if (present) break;
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop += 200;
    });
    await page.waitForTimeout(120);
  }

  // Initial (inactive) read: brackets and URL should be hidden.
  const initialText = await page.evaluate(() => {
    const line = Array.from(document.querySelectorAll('.cm-line')).find(
      (el) => (el.textContent || '').includes('A link to'),
    );
    return line ? (line.textContent || '') : null;
  });
  if (!initialText) {
    record('link: inactive line hides brackets + URL', 'fail', 'sample line not rendered');
    return;
  }
  const initiallyCollapsed =
    initialText.includes('A link to example for reference.') &&
    !initialText.includes('https://') &&
    !initialText.includes('](');
  record(
    'link: inactive line hides brackets + URL',
    initiallyCollapsed ? 'pass' : 'fail',
    `text=${JSON.stringify(initialText.slice(0, 80))}`,
  );

  // Click somewhere on the same line but NOT on the link — between
  // "A" and "link", near the start. Old behavior revealed the URL
  // for the whole line. New behavior should keep the link collapsed.
  const lineHandle = page.locator('.cm-line', { hasText: 'A link to' }).first();
  const box = await lineHandle.boundingBox();
  if (!box) {
    record('link: line-active-but-outside-link stays collapsed', 'fail', 'no bbox');
    return;
  }
  await page.mouse.click(box.x + 10, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const lineActiveText = await page.evaluate(() => {
    const line = Array.from(document.querySelectorAll('.cm-line')).find(
      (el) => (el.textContent || '').includes('A link'),
    );
    return line ? (line.textContent || '') : null;
  });
  const stayedCollapsed =
    lineActiveText !== null &&
    !lineActiveText.includes('](') &&
    !lineActiveText.includes('https://');
  record(
    'link: line-active-but-outside-link stays collapsed',
    stayedCollapsed ? 'pass' : 'fail',
    `text=${JSON.stringify((lineActiveText ?? '').slice(0, 80))}`,
  );

  // Now click directly on the link's rendered text. Reach through
  // the .cm-atomic-link span to get a click target that lands on
  // the link's text range.
  const linkBox = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    const line = lines.find((el) => (el.textContent || '').includes('A link to'));
    if (!line) return null;
    const link = line.querySelector('.cm-atomic-link');
    if (!link) return null;
    const r = link.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (!linkBox) {
    record('link: cursor inside link reveals brackets + URL', 'fail', 'no .cm-atomic-link');
    return;
  }
  // Click slightly left of the right edge of the span to avoid the
  // external-link icon zone (last ~1.25em), which triggers open-URL.
  await page.mouse.click(linkBox.x + Math.max(4, linkBox.w * 0.4), linkBox.y + linkBox.h / 2);
  await page.waitForTimeout(200);
  const insideLinkText = await page.evaluate(() => {
    const line = Array.from(document.querySelectorAll('.cm-line')).find(
      (el) => (el.textContent || '').includes('A link'),
    );
    return line ? (line.textContent || '') : null;
  });
  const revealed =
    insideLinkText !== null &&
    insideLinkText.includes('](') &&
    insideLinkText.includes('https://example.org');
  record(
    'link: cursor inside link reveals brackets + URL',
    revealed ? 'pass' : 'fail',
    `text=${JSON.stringify((insideLinkText ?? '').slice(0, 80))}`,
  );

  // Finally, click outside the line entirely and confirm the link
  // collapses back.
  const escapesLine = page.locator('.cm-line', { hasText: 'Escapes like' }).first();
  if ((await escapesLine.count()) > 0) {
    const eBox = await escapesLine.boundingBox();
    if (eBox) {
      await page.mouse.click(eBox.x + 10, eBox.y + eBox.height / 2);
      await page.waitForTimeout(200);
      const collapsedAgain = await page.evaluate(() => {
        const line = Array.from(document.querySelectorAll('.cm-line')).find(
          (el) => (el.textContent || '').includes('A link to'),
        );
        return line ? !((line.textContent || '').includes('](')) : false;
      });
      record(
        'link: cursor leaves link → collapses again',
        collapsedAgain ? 'pass' : 'fail',
        `collapsedAgain=${collapsedAgain}`,
      );
    }
  }
}

async function probeImageBlock(page) {
  // The sample's Block showcase section includes an image; after
  // mount there should be at least one rendered `.cm-atomic-image`
  // widget in the DOM, with an actual `<img>` inside pointing at the
  // URL parsed from the source. Natural images smaller than the
  // content width should NOT be upscaled.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  // Scroll until an image widget lands in the virtualized viewport.
  for (let step = 0; step < 15; step++) {
    const present = await page.evaluate(
      () => document.querySelector('.cm-atomic-image') !== null,
    );
    if (present) break;
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop += 250;
    });
    await page.waitForTimeout(150);
  }
  // Give the image's intrinsic size a beat to settle.
  await page.waitForTimeout(300);

  const imgInfo = await page.evaluate(() => {
    const widget = document.querySelector('.cm-atomic-image');
    if (!widget) return { found: false };
    const img = widget.querySelector('img');
    if (!img) return { found: true, hasImg: false };
    // Wait for intrinsic size
    return {
      found: true,
      hasImg: true,
      src: img.src,
      natural: { w: img.naturalWidth, h: img.naturalHeight },
      rendered: { w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) },
    };
  });

  if (!imgInfo.found) {
    record('image block: widget rendered', 'fail', 'no .cm-atomic-image in DOM');
    return;
  }
  if (!imgInfo.hasImg) {
    record('image block: widget rendered', 'fail', 'widget has no <img>');
    return;
  }

  record(
    'image block: widget rendered',
    'pass',
    `src=${imgInfo.src.slice(0, 40)} natural=${imgInfo.natural.w}x${imgInfo.natural.h}`,
  );

  // Verify no upscaling: rendered width should equal natural width if
  // natural < container width. Allow a 1px tolerance for subpixel
  // rounding.
  const notUpscaled = imgInfo.rendered.w <= imgInfo.natural.w + 1;
  record(
    'image block: no upscaling below natural size',
    notUpscaled ? 'pass' : 'fail',
    `natural=${imgInfo.natural.w}px rendered=${imgInfo.rendered.w}px`,
  );

  // Click the image widget and verify the source-line markdown
  // reappears. Inactive image lines have their `![alt](url)` text
  // hidden via a Replace decoration; activating the line (cursor
  // on it) removes the decoration so the raw text is back in the
  // rendered `.cm-line`'s textContent. We test that transition.
  const widget = page.locator('.cm-atomic-image').first();
  await widget.click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(250);
  const revealedSource = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    const source = lines.find((el) =>
      (el.textContent || '').includes('![') &&
      (el.textContent || '').includes('](http'),
    );
    if (!source) return { found: false };
    return {
      found: true,
      text: (source.textContent || '').slice(0, 60),
    };
  });

  if (!revealedSource.found) {
    record('image block: click reveals source markdown', 'fail', 'no source line with `![...](...)` in DOM');
  } else {
    record(
      'image block: click reveals source markdown',
      'pass',
      `text=${JSON.stringify(revealedSource.text)}`,
    );
  }
}

async function probeTaskList(page) {
  // Focus the editor on a known non-widget line, then jump to doc end.
  // Tables (block widgets) sit in the middle of .cm-content, so a
  // bare `content.click()` can land inside a table cell and trap
  // subsequent keystrokes in its contenteditable instead of the CM6
  // editor.
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  const firstPlainLine = page.locator('.cm-line:not([class*="cm-atomic"])').first();
  const box = await firstPlainLine.boundingBox();
  if (box) {
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
  }
  await page.waitForTimeout(180);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  const uniq = `TASK_${Date.now().toString(36).slice(-4)}`;
  await page.keyboard.type(`- [ ] ${uniq}`);
  await page.waitForTimeout(300);

  const checkboxCount = await page
    .locator(`.cm-line:has-text("${uniq}") input.cm-atomic-task-checkbox`)
    .count();
  record(
    'task list: checkbox appears',
    checkboxCount > 0 ? 'pass' : 'fail',
    `checkbox count on task line = ${checkboxCount}`,
  );
  if (checkboxCount === 0) return;

  const checkbox = page
    .locator(`.cm-line:has-text("${uniq}") input.cm-atomic-task-checkbox`)
    .first();

  // Click to toggle. Use force: true because the input is a widget and
  // Playwright's normal actionability checks (not-covered, stable) can
  // trip over decoration rebuilds.
  await checkbox.click({ force: true });
  await page.waitForTimeout(150);

  const checkedNow = await checkbox.evaluate((el) => el.checked);
  record(
    'task list: click toggles checked',
    checkedNow ? 'pass' : 'fail',
    `checkbox.checked = ${checkedNow}`,
  );

  // Enter on a task line should create another task (not a plain
  // bullet). Place cursor at end of the current task, press Enter,
  // type a marker for the new item, and assert a second checkbox
  // appears.
  const nextMarker = `NEXT_${Date.now().toString(36).slice(-4)}`;
  await page.locator(`.cm-line:has-text("${uniq}")`).first().click({ force: true });
  await page.waitForTimeout(180);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(nextMarker);
  await page.waitForTimeout(200);

  const nextHasCheckbox = await page
    .locator(`.cm-line:has-text("${nextMarker}") input.cm-atomic-task-checkbox`)
    .count();
  record(
    'task list: Enter continues as task',
    nextHasCheckbox > 0 ? 'pass' : 'fail',
    `new line checkbox count = ${nextHasCheckbox}`,
  );

  const lineClasses = await page
    .locator(`.cm-line:has-text("${uniq}")`)
    .first()
    .evaluate((el) => el.className);
  const hasDoneClass = /cm-atomic-task-done/.test(lineClasses);
  record(
    'task list: completed line strikes through',
    hasDoneClass ? 'pass' : 'fail',
    `classes="${lineClasses}"`,
  );

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '24-task-list.png'), fullPage: false });
}

async function probeTyping(page) {
  // Cursor should already be somewhere in the doc. Type a burst of
  // characters and watch CLS.
  const cls = await measureCLS(page, 1200, async () => {
    for (const ch of 'hello world') {
      await page.keyboard.press(ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`);
      await page.waitForTimeout(25);
    }
  });
  const status = cls.total < 0.05 ? 'pass' : cls.total < 0.2 ? 'warn' : 'fail';
  record('type inside line (CLS)', status, `total=${cls.total.toFixed(3)} shifts=${cls.count}`);
  return cls;
}

async function probeDeepScrollRenders(page) {
  // Regression guard for "content past the initial parse window appears
  // as raw markdown until a click nudges the parser forward." We scroll
  // to the bottom half of the doc and check that the headings in the
  // fresh viewport actually picked up their `cm-atomic-h*` classes
  // (i.e., the decoration plugin rebuilt with a tree that reaches here).
  const editor = page.locator('.cm-scroller');
  await editor.evaluate((el) => {
    el.scrollTop = el.scrollHeight * 0.75;
  });
  // Let CM6 re-measure + our plugin rebuild decorations.
  await page.waitForTimeout(350);

  const headingsInViewport = await page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller');
    if (!scroller) return null;
    const vRect = scroller.getBoundingClientRect();
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    let decorated = 0;
    let rawHeadings = 0;
    for (const el of lines) {
      const r = el.getBoundingClientRect();
      if (r.bottom < vRect.top || r.top > vRect.bottom) continue;
      const text = el.textContent || '';
      const looksLikeHeading = /^#{1,6}\s/.test(text);
      const hasHeadingClass = /\bcm-atomic-h[1-6]\b/.test(el.className);
      if (hasHeadingClass) decorated++;
      // Raw heading = doc-side `## foo` with NO `cm-atomic-h*` class →
      // the decoration failed to apply. That's the bug.
      if (looksLikeHeading && !hasHeadingClass) rawHeadings++;
    }
    return { decorated, rawHeadings };
  });

  const status =
    headingsInViewport && headingsInViewport.rawHeadings === 0 ? 'pass' : 'fail';
  record(
    'deep-scroll headings decorate',
    status,
    `decorated=${headingsInViewport?.decorated ?? '?'} raw=${headingsInViewport?.rawHeadings ?? '?'}`,
  );
}

async function probeScroll(page) {
  const editor = page.locator('.cm-scroller');
  await editor.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  const cls = await measureCLS(page, 2000, async () => {
    await editor.evaluate(async (el) => {
      const step = Math.max(el.clientHeight * 0.8, 400);
      for (let i = 0; i < 10; i++) {
        el.scrollTop += step;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
    });
  });
  const status = cls.total < 0.15 ? 'pass' : cls.total < 0.6 ? 'warn' : 'fail';
  const topSrc = topShiftSources(cls.entries, 3);
  record('scroll CLS (2s)', status, `total=${cls.total.toFixed(3)} shifts=${cls.count}${topSrc ? ` sources=${topSrc}` : ''}`);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-after-scroll.png'), fullPage: false });
  return cls;
}

async function probeSelection(page) {
  const editor = page.locator('.cm-scroller');
  await editor.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);

  // Drag across multiple visible lines.
  const lines = page.locator('.cm-line:not(:empty)');
  const count = await lines.count();
  if (count < 3) {
    record('drag-select across lines', 'fail', `only ${count} lines visible`);
    return null;
  }
  const firstBox = await lines.nth(1).boundingBox();
  const lastBox = await lines.nth(Math.min(count - 1, 5)).boundingBox();
  if (!firstBox || !lastBox) {
    record('drag-select across lines', 'fail', 'no bbox');
    return null;
  }

  const startX = firstBox.x + 20;
  const startY = firstBox.y + firstBox.height / 2;
  const endX = lastBox.x + Math.min(200, lastBox.width - 20);
  const endY = lastBox.y + lastBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 18;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(startX + (endX - startX) * t, startY + (endY - startY) * t);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.waitForTimeout(150);

  const selection = await page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { empty: true };
    const s = sel.toString();
    return { empty: s.length === 0, length: s.length };
  });

  if (selection.empty) {
    record('drag-select across lines', 'fail', 'window.getSelection() empty');
  } else {
    record('drag-select across lines', 'pass', `len=${selection.length}B`);
  }
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-selection.png'), fullPage: false });
  return selection;
}

async function probeCopyIsRawMarkdown(page) {
  // Synthesize a copy event and capture what CM6 puts on the clipboard.
  const payload = await page.evaluate(() => {
    const target = document.querySelector('.cm-content');
    if (!target) return { error: 'no .cm-content' };
    const dt = new DataTransfer();
    const ev = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: dt });
    target.dispatchEvent(ev);
    return { text: dt.getData('text/plain') };
  });
  if (!payload || payload.error) {
    record('copy yields raw markdown', 'fail', payload?.error || 'unknown');
    return null;
  }
  const text = payload.text || '';
  const looksLikeMarkdown =
    /(^|\n)#{1,6}\s|\*\*|`{1,3}|(^|\n)[-*]\s|\[[^\]]+\]\(/.test(text) || text.length > 40;
  const status = text && looksLikeMarkdown ? 'pass' : 'warn';
  const preview = text.slice(0, 60).replace(/\n/g, '\\n');
  record('copy yields raw markdown', status, `len=${text.length}B preview="${preview}"`);
  return payload;
}

// ---------- driver ----------

async function run() {
  const devProc = await ensureServer();
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.on('weberror', (err) => log('warn', `page weberror: ${err.error().message}`));
  const page = await context.newPage();
  page.on('pageerror', (err) => log('warn', `pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('warn', `console.error: ${msg.text()}`);
  });

  try {
    log('info', `navigating to ${base}/`);
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cm-editor');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-initial.png'), fullPage: false });

    await probeIdle(page);
    // Must run before any probe that focuses/clicks the editor.
    await probeColdLoadH1Hidden(page);
    await probeClickFreeze(page);
    await probeFenceVisibility(page);
    await probeNewBulletList(page);
    await probeNestedListExit(page);
    await probeCloseBrackets(page);
    await probeHeadingClickTargets(page);
    await probeHorizontalRule(page);
    await probeTableWidget(page);
    await probeTableCellMarkdown(page);
    await probeTableFromMarkdown(page);
    await probeImageBlock(page);
    await probeBackslashEscape(page);
    await probeLinkScope(page);
    await probeTaskList(page);
    await probeCursorPingPong(page);
    await probeTyping(page);
    await probeSelection(page);
    await probeCopyIsRawMarkdown(page);
    await probeDeepScrollRenders(page);
    await probeScroll(page);

    const failCount = results.filter((r) => r.status === 'fail').length;
    const warnCount = results.filter((r) => r.status === 'warn').length;
    console.log('');
    log('info', `${results.length} probes: ${failCount} fail, ${warnCount} warn`);
    log('info', `screenshots: ${SCREENSHOT_DIR}`);
    process.exitCode = failCount > 0 ? 1 : 0;
  } finally {
    await browser.close();
    if (devProc && !devProc.killed) {
      devProc.kill('SIGTERM');
      await Promise.race([once(devProc, 'exit'), sleep(2000)]);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { expect, test, type Page } from '@playwright/test';
import {
  focusEditor,
  getMarkdown,
  loadMarkdown,
  openHarness,
} from './support/harness';

test.beforeEach(async ({ page }) => openHarness(page));

function caretBox(page: Page) {
  return page.locator('.cm-cursor-primary').boundingBox();
}

/** Puts the caret at the end of the last line, the way a user does. */
async function clickPastEndOfText(page: Page): Promise<void> {
  await focusEditor(page);
  const line = page.locator('.cm-line').last();
  const box = await line.boundingBox();
  await page.mouse.click(
    (box?.x ?? 0) + (box?.width ?? 0) - 8,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
  );
}

test('@smoke the caret stays visible after typing a wiki link at the end of a line', async ({
  page,
}) => {
  await loadMarkdown(page, 'hello ', { wikiLinks: true });
  await clickPastEndOfText(page);

  // Baseline: the caret sitting after ordinary text.
  const plainCaret = await caretBox(page);
  expect(plainCaret?.height ?? 0).toBeGreaterThan(0);

  await page.keyboard.type('[[atom-1|Target]]');
  expect(await getMarkdown(page)).toBe('hello [[atom-1|Target]]');

  const link = page.locator('.cm-atomic-wiki-link');
  await expect(link).toHaveText('Target');

  // The bug this guards: the link's source was hidden with `font-size: 0`,
  // which left the caret measured against a zero-height box — after typing
  // a link at the end of a line there was no visible cursor at all.
  // Polled because the cursor layer is measured a frame behind the
  // decoration rebuild.
  await expect
    .poll(async () => {
      const chip = await link.boundingBox();
      const caret = await caretBox(page);
      return {
        matchesPlainHeight:
          Math.abs((caret?.height ?? 0) - (plainCaret?.height ?? 0)) <= 1,
        afterChip: (caret?.x ?? 0) >= (chip?.x ?? 0) + (chip?.width ?? 0) - 2,
      };
    })
    .toEqual({ matchesPlainHeight: true, afterChip: true });
});

test('a wiki link keeps its source collapsed with the caret after it', async ({
  page,
}) => {
  await loadMarkdown(page, 'hello ', { wikiLinks: true });
  await clickPastEndOfText(page);
  await page.keyboard.type('[[atom-1|Target]]');

  await expect(page.locator('.cm-atomic-wiki-link')).toHaveText('Target');
  await expect(page.locator('.cm-atomic-wiki-link-active')).toHaveCount(0);
  await expect(page.locator('.cm-content')).not.toContainText('[[');
});

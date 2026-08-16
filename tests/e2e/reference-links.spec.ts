import { expect, test, type Page } from '@playwright/test';
import { focusEditor, loadMarkdown, openHarness } from './support/harness';

test.beforeEach(async ({ page }) => openHarness(page));

/**
 * Colour of the text node containing `needle`, read off the element that
 * actually paints it. Class assertions are not enough here: link colour can
 * come from the decoration or from the syntax highlight style, and only one
 * of those knows whether the reference resolves.
 */
async function colorOfText(page: Page, needle: string): Promise<string> {
  return page.evaluate((text) => {
    const walker = document.createTreeWalker(
      document.querySelector('.cm-content')!,
      NodeFilter.SHOW_TEXT,
    );
    let node = walker.nextNode();
    while (node) {
      if (node.textContent?.includes(text)) {
        return getComputedStyle(node.parentElement!).color;
      }
      node = walker.nextNode();
    }
    return 'not found';
  }, needle);
}

test('@smoke an unresolved reference is painted as ordinary text', async ({
  page,
}) => {
  await loadMarkdown(page, 'plain words\n\nsee [note] below');

  expect(await colorOfText(page, 'note')).toBe(
    await colorOfText(page, 'plain words'),
  );
});

test('a link with a destination is still painted as a link', async ({
  page,
}) => {
  await loadMarkdown(page, 'plain words\n\nsee [note](https://example.com)');

  expect(await colorOfText(page, 'note')).not.toBe(
    await colorOfText(page, 'plain words'),
  );
});

test('a reference with a definition is still painted as a link', async ({
  page,
}) => {
  await loadMarkdown(
    page,
    'plain words\n\nsee [note] below\n\n[note]: https://example.com',
  );

  expect(await colorOfText(page, 'note')).not.toBe(
    await colorOfText(page, 'plain words'),
  );
});

test('@smoke a real link keeps its colour and icon while the cursor is inside it', async ({
  page,
}) => {
  await loadMarkdown(page, 'plain words\n\nsee [note](https://example.com)');
  await focusEditor(page);
  // Click the link text to put the cursor in it, which reveals the source.
  await page.locator('.cm-atomic-link').click({ position: { x: 4, y: 4 } });

  const link = page.locator('.cm-atomic-link');
  await expect(link).toContainText('](https://example.com)');
  expect(await colorOfText(page, 'note')).not.toBe(
    await colorOfText(page, 'plain words'),
  );
  // The external-link icon is a ::after on the link element.
  const icon = await link.evaluate(
    (element) => getComputedStyle(element, '::after').content,
  );
  expect(icon).not.toBe('none');
});

test('wiki-link source keeps link styling and its icon while the cursor is inside it', async ({
  page,
}) => {
  await loadMarkdown(page, 'plain words\n\nsee [[atom-1|Target]] here', {
    wikiLinks: true,
  });
  await focusEditor(page);
  await page.locator('.cm-atomic-wiki-link').click({ modifiers: ['Shift'] });

  await expect(page.locator('.cm-atomic-wiki-link-active')).toHaveCount(1);
  expect(await colorOfText(page, 'atom-1')).not.toBe(
    await colorOfText(page, 'plain words'),
  );

  // Styling covers the inner `[target|label]` and nothing more, so the
  // icon lands between the closing brackets, where it always did.
  const inner = page.locator('.cm-atomic-wiki-link-active .cm-atomic-link');
  await expect(inner).toHaveText('[atom-1|Target]');
  const icon = await inner.evaluate(
    (element) => getComputedStyle(element, '::after').content,
  );
  expect(icon).not.toBe('none');
});

test('a wiki link split across two lines is painted as ordinary text', async ({
  page,
}) => {
  await loadMarkdown(page, 'plain words\n\nsee [[demo\nlink]] here', {
    wikiLinks: true,
  });

  const plain = await colorOfText(page, 'plain words');
  expect(await colorOfText(page, 'demo')).toBe(plain);
  expect(await colorOfText(page, 'link')).toBe(plain);
});

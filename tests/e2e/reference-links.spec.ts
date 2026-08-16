import { expect, test, type Page } from '@playwright/test';
import { loadMarkdown, openHarness } from './support/harness';

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

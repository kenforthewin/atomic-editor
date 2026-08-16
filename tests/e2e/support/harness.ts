import { expect, type Page } from '@playwright/test';

export interface HarnessOptions {
  readOnly?: boolean;
  theme?: 'dark' | 'light';
  wikiLinks?: boolean;
}

interface HarnessWindow extends Window {
  atomicHarness?: {
    focus(): void;
    getMarkdown(): string;
    getOpenedUrls(): string[];
    load(markdown: string, options?: HarnessOptions): Promise<void>;
  };
}

export async function openHarness(page: Page): Promise<void> {
  await page.goto('/harness.html');
  await page.waitForFunction(() => {
    const harnessWindow = window as HarnessWindow;
    return typeof harnessWindow.atomicHarness?.load === 'function';
  });
}

export async function loadMarkdown(
  page: Page,
  markdown: string,
  options: HarnessOptions = {},
): Promise<void> {
  await page.evaluate(
    async ({ source, fixtureOptions }) => {
      const harnessWindow = window as HarnessWindow;
      await harnessWindow.atomicHarness?.load(source, fixtureOptions);
    },
    { source: markdown, fixtureOptions: options },
  );
  await expect(page.locator('.cm-editor')).toHaveCount(1);
}

export async function getMarkdown(page: Page): Promise<string> {
  return page.evaluate(() => {
    const harnessWindow = window as HarnessWindow;
    return harnessWindow.atomicHarness?.getMarkdown() ?? '';
  });
}

export async function focusEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harnessWindow = window as HarnessWindow;
    harnessWindow.atomicHarness?.focus();
  });
}

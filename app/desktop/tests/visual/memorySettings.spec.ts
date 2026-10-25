import { expect, test, type Locator, type Page } from '@playwright/test';

// Settings › Memory with the preview memories: every memory of the account in one list, with the
// category, card and origin labels, the filter rows, and the "+ Card" checklist open.

test.use({ viewport: { width: 1280, height: 1000 } });

/** Keeps the shots independent of the host's "Show scroll bars" setting (no classic gutter). */
async function hideScrollbars(page: Page) {
  await page.addStyleTag({
    content:
      '*::-webkit-scrollbar { display: none !important; } * { scrollbar-width: none !important; scrollbar-gutter: auto !important; scroll-behavior: auto !important; }',
  });
}

/**
 * The settings dialog has a fixed height, so the shots scroll its content column to a target. The
 * offset is set directly on the nearest scrolling ancestor (no scrollIntoView, no smooth scroll),
 * then settled over two frames and the fonts, and asserted before the capture.
 */
async function scrollTo(page: Page, target: Locator) {
  await page.addStyleTag({ content: '* { scroll-behavior: auto !important; }' });
  await target.evaluate(async (el) => {
    let container: HTMLElement | null = el.parentElement;
    while (container) {
      const overflowY = getComputedStyle(container).overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && container.scrollHeight > container.clientHeight) break;
      container = container.parentElement;
    }
    if (!container) throw new Error('no scroll container above the target');
    const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop;
    const top = Math.round(container.scrollTop + offset);
    container.scrollTop = top;
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (Math.abs(container.scrollTop - Math.min(top, container.scrollHeight - container.clientHeight)) > 0.5) {
      throw new Error(`scroll not settled: ${container.scrollTop} vs ${top}`);
    }
  });
}

const listHeading = (page: Page) => page.getByRole('heading', { name: 'All memories · 10' });

for (const theme of ['light', 'dark'] as const) {
  test(`memory settings organizer (${theme})`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
    await page.goto(`/tests/visual/memorySettings.html?theme=${theme}`);
    await hideScrollbars(page);
    await expect(page.getByRole('heading', { name: 'All memories · 10' })).toBeVisible();
    const organizer = page.locator('[data-memory-organizer]');
    await expect(organizer.getByRole('button', { name: 'Every card' }).first()).toBeVisible();
    await expect(organizer.getByRole('button', { name: 'Design review' }).first()).toBeVisible();
    await expect(page.getByText("Other memories are on each conversation's Memory tab.")).toHaveCount(0);
    await scrollTo(page, listHeading(page));
    await expect(page).toHaveScreenshot(`memorySettings-organizer-${theme}.png`);
  });
}

test('memory settings organizer with a filter and the card checklist (light)', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.goto('/tests/visual/memorySettings.html?theme=light');
  await hideScrollbars(page);
  const organizer = page.locator('[data-memory-organizer]');
  await expect(page.getByRole('heading', { name: 'All memories · 10' })).toBeVisible();
  await scrollTo(page, listHeading(page));
  await organizer.locator('[data-memory-filter-layer="from"]').getByRole('button', { name: /^Global/ }).click();
  await expect(organizer.locator('[data-memory-lesson]')).toHaveCount(2);
  await expect(organizer.getByRole('button', { name: 'Clear' })).toBeVisible();
  await organizer.locator('[data-memory-lesson="lesson-8"] [data-memory-label="add-card"]').click();
  await expect(organizer.getByRole('menuitemcheckbox', { name: 'Lab card' })).toBeVisible();
  await scrollTo(page, listHeading(page));
  await expect(page).toHaveScreenshot('memorySettings-organizer-filtered-light.png');
});

test('memory settings organizer, project and group rows (light)', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.goto('/tests/visual/memorySettings.html?theme=light');
  await hideScrollbars(page);
  const organizer = page.locator('[data-memory-organizer]');
  await expect(page.getByRole('heading', { name: 'All memories · 10' })).toBeVisible();
  // Group rows show the category and the group, never cards; another member's row has no category menu.
  const group = organizer.locator('[data-memory-lesson="lesson-10"]');
  await expect(group.getByRole('button', { name: 'Design review' })).toBeVisible();
  await expect(group.locator('[data-memory-label="add-card"]')).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Change category' })).toHaveCount(0);
  await scrollTo(page, group);
  await expect(page).toHaveScreenshot('memorySettings-organizer-rows-light.png');
});

async function openImport(page: Page, theme: 'light' | 'dark') {
  await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.goto(`/tests/visual/memorySettings.html?theme=${theme}`);
  await hideScrollbars(page);
  await expect(page.getByRole('heading', { name: 'All memories · 10' })).toBeVisible();
  const importHeading = page.getByRole('heading', { name: 'Import', exact: true });
  return { importHeading, section: page.locator('section', { has: importHeading }) };
}

// Opens Claude Code and its launch-site project.
async function expandLaunchSite(section: Locator) {
  await section.getByRole('treeitem', { name: 'Claude Code', exact: true }).getByRole('button', { name: /^Claude Code/ }).click();
  await section.getByRole('treeitem', { name: 'Claude Code launch-site', exact: true }).getByRole('button', { name: /^launch-site/ }).click();
  await expect(section.getByRole('checkbox', { name: 'launch-site memory/feedback-always-checkpoint.md' })).toBeChecked();
}

test('memory settings import section, collapsed, opened and after an import (light)', async ({ page }) => {
  const { importHeading, section } = await openImport(page, 'light');
  await expect(section.getByRole('checkbox', { name: 'Claude Code', exact: true })).toBeChecked();
  await expect(section.getByRole('checkbox', { name: 'Project files', exact: true })).toBeChecked();
  await expect(section.locator('[data-memory-import-row]')).toHaveCount(2);
  await expect(section.getByText('9 files selected')).toBeVisible();
  await scrollTo(page, importHeading);
  await expect(page).toHaveScreenshot('memorySettings-import-light.png');
  await expandLaunchSite(section);
  await scrollTo(page, importHeading);
  await expect(page).toHaveScreenshot('memorySettings-import-expanded-light.png');
  // The chooser's fixture returns a new file and one already listed, which is not added twice.
  await section.getByRole('button', { name: 'Choose files…' }).click();
  await expect(section.getByRole('checkbox', { name: 'Chosen files', exact: true })).toBeChecked();
  await expect(section.getByText('10 files selected')).toBeVisible();
  await section.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(section.getByText('Imported 5 memories.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'All memories · 15' })).toBeVisible();
  await scrollTo(page, importHeading);
  await expect(page).toHaveScreenshot('memorySettings-import-done-light.png');
});

test('memory settings import section, opened (dark)', async ({ page }) => {
  const { importHeading, section } = await openImport(page, 'dark');
  await expandLaunchSite(section);
  await scrollTo(page, importHeading);
  await expect(page).toHaveScreenshot('memorySettings-import-expanded-dark.png');
});

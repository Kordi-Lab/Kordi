import { expect, test, type Page } from '@playwright/test';

async function expectAlignedHeaders(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const rect = (selector: string) => {
      const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, y, width, height };
    };
    const bounds = {
      mainTitle: rect('.app-native-titlebar-title .app-chat-pane-title-row'),
      panelTitle: rect('.app-native-companion-titlebar [role="tab"][aria-selected="true"]'),
      panelHeader: rect('.app-native-companion-titlebar'),
      panelBody: rect('.app-companion-panel-surface'),
      mainHeader: rect('.app-native-titlebar-main'),
      mainBody: rect('.app-chat-main-workspace'),
    };
    return {
      // The active pane tab is taller than the main title; both share one vertical centre.
      titleCentre: Math.abs((bounds.mainTitle.y + bounds.mainTitle.height / 2) - (bounds.panelTitle.y + bounds.panelTitle.height / 2)) < 1,
      panelOffset: Math.abs(bounds.panelHeader.x - bounds.panelBody.x) < 1,
      panelWidth: Math.abs(bounds.panelHeader.width - bounds.panelBody.width) < 1,
      mainOffset: Math.abs(bounds.mainHeader.x - bounds.mainBody.x) < 1,
      mainWidth: Math.abs(bounds.mainHeader.width - bounds.mainBody.width) < 1,
    };
  })).toEqual({ titleCentre: true, panelOffset: true, panelWidth: true, mainOffset: true, mainWidth: true });
}

test('native panel titles and controls follow the split through resizing, moving and reopening', async ({ page }) => {
  await page.goto('/tests/visual/chatProjectWorkspace.html?theme=dark');
  // Exercise the real macOS outer inset as well as the native component fixture.
  await page.evaluate(() => document.documentElement.classList.add('kordi-native-shell'));
  const chat = page.getByRole('group', { name: 'Companion panel' }).getByRole('button', { name: 'Chat', exact: true });
  await chat.click();
  const header = page.locator('.app-native-companion-titlebar');
  const panelHeader = page.locator('[data-chat-side-agent-panel] .app-chat-pane-header');
  // The shared pane tabs own the title row; the session's controls stay beside its destinations.
  await expect(header.getByRole('tab', { name: 'Fix transcript scroll jitter', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(header.getByRole('button', { name: 'Hide panel' })).toBeVisible();
  await expect(panelHeader).toHaveCount(1);
  await expect(page.locator('[data-chat-side-agent-panel] .app-chat-pane-header.app-chat-native-metadata-header [data-chat-destination-tabs="companion"]')).toBeVisible();
  await expect(page.locator('[data-chat-side-agent-panel] .app-chat-pane-title-row')).toHaveCount(0);
  await expect(panelHeader.getByRole('button', { name: 'Close side chat' })).toBeVisible();
  await expectAlignedHeaders(page);
  const divider = page.getByRole('separator', { name: 'Resize side-by-side chats' });
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  await expectAlignedHeaders(page);
  await page.setViewportSize({ width: 1020, height: 760 });
  await expectAlignedHeaders(page);
  await page.setViewportSize({ width: 1440, height: 1040 });
  await panelHeader.dragTo(page.locator('[data-chat-split-workspace]'), { targetPosition: { x: 30, y: 200 } });
  await expect(header).toHaveAttribute('data-side', 'left');
  await expectAlignedHeaders(page);
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expectAlignedHeaders(page);
  // The first strip control clears the window buttons when the pane sits on the left.
  const firstControl = await header.locator('.app-document-tabs-header > button').first().boundingBox();
  expect(firstControl!.x).toBeGreaterThanOrEqual(120);
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expectAlignedHeaders(page);
  await panelHeader.getByRole('button', { name: 'Side chat options' }).click();
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panelHeader.getByRole('button', { name: 'Side chat options' })).toBeFocused();
  await panelHeader.getByRole('button', { name: 'Close side chat' }).focus();
  await page.keyboard.press('Enter');
  await expect(header).toBeHidden();
  await expect(chat).toBeFocused();
  await chat.click();
  await expect(header).toBeVisible();
  await expectAlignedHeaders(page);
});

test('Digest and Calendar open as tabs on the shared title row with a top-right hide control', async ({ page }) => {
  await page.goto('/tests/visual/chatProjectWorkspace.html');
  const toolbar = page.getByRole('group', { name: 'Companion panel' });
  for (const name of ['Digest', 'Calendar']) {
    await toolbar.getByRole('button', { name, exact: true }).click();
    const header = page.locator('.app-native-companion-titlebar');
    await expect(header.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(header.getByRole('button', { name: 'Hide panel' })).toBeVisible();
    await expectAlignedHeaders(page);
    await expect(page.getByRole('complementary', { name: `${name} panel` }).locator('header')).toHaveCount(0);
    await header.getByRole('button', { name: 'Hide panel' }).click();
    await expect(header).toBeHidden();
  }
});

test.describe('native split motion', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('the sidebar button keeps its bounds while its icon and expanded state change', async ({ page }) => {
    await page.goto('/tests/visual/chatProjectWorkspace.html');
    await page.evaluate(() => document.documentElement.classList.add('kordi-native-shell'));
    await page.getByRole('group', { name: 'Companion panel' }).getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.locator('.app-native-companion-titlebar')).toBeVisible();
    const button = page.locator('.app-native-titlebar-navigation > button');
    const initialBounds = (await button.boundingBox())!;
    const expandedIcon = await button.locator('svg').innerHTML();
    for (const collapsed of [true, false]) {
      const samples = await page.evaluate(async () => {
        const button = document.querySelector<HTMLButtonElement>('.app-native-titlebar-navigation > button')!;
        const measure = () => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return { x, y, width, height };
        };
        const bounds = [measure()];
        button.click();
        const start = performance.now();
        while (performance.now() - start < 360) {
          await new Promise(requestAnimationFrame);
          bounds.push(measure());
        }
        return bounds;
      });
      for (const sample of samples) {
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          expect(Math.abs(sample[key] - initialBounds[key])).toBeLessThan(0.1);
        }
      }
      await expect(button).toHaveAttribute('aria-expanded', String(!collapsed));
      const icon = await button.locator('svg').innerHTML();
      if (collapsed) expect(icon).not.toEqual(expandedIcon);
      else expect(icon).toEqual(expandedIcon);
      await expectAlignedHeaders(page);
    }
  });
  test('the main title and actions follow the conversation throughout panel motion', async ({ page }) => {
    await page.goto('/tests/visual/chatProjectWorkspace.html?theme=dark');
    for (const open of [true, false]) {
      // Chat opens its tab; the fold control closes the pane while keeping its tabs.
      const samples = await page.evaluate(async (label) => {
        const measure = () => ({
          title: document.querySelector('.app-native-titlebar-main')!.getBoundingClientRect().width,
          body: document.querySelector('.app-chat-main-workspace')!.getBoundingClientRect().width,
        });
        const widths = [measure()];
        document.querySelector<HTMLButtonElement>(`.app-companion-toolbar button[aria-label="${label}"]`)!.click();
        const start = performance.now();
        while (performance.now() - start < 360) {
          await new Promise(requestAnimationFrame);
          widths.push(measure());
        }
        return widths;
      }, open ? 'Chat' : 'Fold pane');
      expect(Math.max(...samples.map(sample => Math.abs(sample.title - sample.body)))).toBeLessThan(1);
      expect(Math.abs(samples[0].body - samples.at(-1)!.body)).toBeGreaterThan(150);
      await expect(page.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-pressed', String(open));
    }
  });
});

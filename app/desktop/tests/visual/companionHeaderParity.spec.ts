import { expect, test, type Page } from '@playwright/test';

const preview = '/tests/visual/chatProjectWorkspace.html';
const tabs = ['Messages', 'Info', 'Artifacts', 'Tasks'];
const chatThemes = ['default', 'quiet', 'midnight', 'sand', 'ocean'] as const;

const mainPane = '.app-chat-main-workspace';
const panel = '[data-chat-side-agent-panel]';

async function openPanel(page: Page, query: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${preview}?destinations=1&${query}`);
  await page.getByRole('group', { name: 'Companion panel' }).getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator(`${panel}:visible`)).toHaveAttribute('data-companion-session-id', 'chat-0');
  await expect(page.locator(`${panel} [data-chat-destination-tabs="companion"]`)).toBeVisible();
  return errors;
}

/** Computed styles that make up the header's visual language for one pane. */
async function headerStyle(page: Page, scope: string, headerSelector: string, titleSelector: string) {
  return page.evaluate(({ scope, headerSelector, titleSelector }) => {
    const header = document.querySelector(`${scope} ${headerSelector}`)!;
    const titleRow = document.querySelector(titleSelector)!;
    const title = titleRow.querySelector('h2') ?? titleRow;
    const tabList = document.querySelector(`${scope} [data-chat-destination-tabs]`)!;
    const active = tabList.querySelector<HTMLElement>('[aria-selected="true"]')!;
    const inactive = tabList.querySelector<HTMLElement>('[aria-selected="false"]')!;
    const css = getComputedStyle;
    return {
      headerHeight: Math.round(header.getBoundingClientRect().height),
      headerBackground: css(header).backgroundColor,
      headerBorder: css(header).borderBottomColor,
      titleHeight: Math.round(titleRow.getBoundingClientRect().height),
      titleFont: `${css(title).fontSize} ${css(title).fontWeight} ${css(title).lineHeight}`,
      tabRowHeight: Math.round(tabList.getBoundingClientRect().height),
      tabRowBottomGap: Math.round(header.getBoundingClientRect().bottom - tabList.getBoundingClientRect().bottom),
      tabLabels: Array.from(tabList.querySelectorAll('[role="tab"]'), (tab) => tab.textContent),
      tabGap: css(tabList.firstElementChild!).gap,
      activeColor: css(active).color,
      activeUnderline: css(active, '::after').backgroundColor,
      activeFont: `${css(active).fontSize} ${css(active).fontWeight}`,
      activePadding: css(active).padding,
      inactiveColor: css(inactive).color,
      inactiveUnderline: css(inactive, '::after').backgroundColor,
    };
  }, { scope, headerSelector, titleSelector });
}

const inPaneSelectors = {
  main: [mainPane, '.app-chat-pane-header', `${mainPane} .app-chat-pane-title-row`],
  panel: [panel, '.app-chat-pane-header', `${panel} .app-chat-pane-title-row`],
} as const;
const nativeSelectors = {
  main: [mainPane, '.app-chat-native-metadata-header', '.app-native-titlebar-title .app-chat-pane-title-row'],
  panel: [panel, '.app-chat-native-metadata-header', '.app-native-companion-titlebar .app-chat-pane-title-row'],
} as const;

async function expectMatchingHeaders(page: Page, selectors: typeof inPaneSelectors | typeof nativeSelectors) {
  const main = await headerStyle(page, ...selectors.main);
  const side = await headerStyle(page, ...selectors.panel);
  expect(main.tabLabels).toEqual(tabs);
  expect(side).toEqual(main);
  expect(side.activeUnderline).not.toBe(side.inactiveUnderline);
  return side;
}

for (const appearance of ['light', 'dark'] as const) {
  test(`${appearance}: Ask Agent header and tabs match the main chat`, async ({ page }, testInfo) => {
    const errors = await openPanel(page, `theme=${appearance}&native=0`);
    const header = page.locator(`${panel} .app-chat-pane-header`);
    await expect(header.getByRole('heading')).toHaveText('Ask Agent · Fix transcript scroll jitter');
    await expect(header.getByRole('button', { name: 'Side chat options' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Close side chat' })).toBeVisible();
    await expectMatchingHeaders(page, inPaneSelectors);
    await page.screenshot({ path: testInfo.outputPath(`companion-header-parity-${appearance}.png`) });

    for (const theme of chatThemes) {
      await page.evaluate((value) => {
        if (value === 'default') delete document.body.dataset.kordiChatTheme;
        else document.body.dataset.kordiChatTheme = value;
      }, theme);
      await expectMatchingHeaders(page, inPaneSelectors);
    }
    await page.evaluate(() => { delete document.body.dataset.kordiChatTheme; });

    const tabList = page.getByRole('navigation', { name: 'Ask Agent destinations' });
    for (const name of ['Info', 'Artifacts', 'Tasks', 'Messages']) {
      await tabList.getByRole('tab', { name, exact: true }).click();
      await expect(tabList.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.mouse.move(0, 0);
      // The selected panel tab settles on the same accent color and underline as the main chat's active tab.
      await expect.poll(() => page.evaluate(() => {
        const look = (selector: string) => {
          const tab = document.querySelector(selector)!;
          return `${getComputedStyle(tab).color} ${getComputedStyle(tab, '::after').backgroundColor}`;
        };
        return look('[data-chat-side-agent-panel] [role="tab"][aria-selected="true"]')
          === look('.app-chat-main-workspace [role="tab"][aria-selected="true"]');
      })).toBe(true);
      const destination = name.toLowerCase();
      await expect(page.locator(`#chat-companion-${destination}-panel`)).toBeVisible();
      await expect(page.locator(`${mainPane} [data-chat-destination-tab="messages"]`)).toHaveAttribute('aria-selected', 'true');
      if (name === 'Info') {
        await page.screenshot({ path: testInfo.outputPath(`companion-header-parity-${appearance}-info.png`) });
      }
    }
    expect(errors).toEqual([]);
  });

  test(`${appearance}: native title row keeps the Ask Agent tabs aligned with the main chat`, async ({ page }, testInfo) => {
    const errors = await openPanel(page, `theme=${appearance}`);
    const titlebar = page.locator('.app-native-companion-titlebar');
    await expect(titlebar.getByRole('heading')).toHaveText('Ask Agent · Fix transcript scroll jitter');
    await expect(titlebar.getByRole('button', { name: 'Close side chat' })).toBeVisible();
    await expect(titlebar.locator('[data-chat-destination-tabs]')).toHaveCount(0);
    await expect(page.locator(`${panel} .app-chat-pane-title-row`)).toHaveCount(0);
    const side = await expectMatchingHeaders(page, nativeSelectors);
    expect(side.titleHeight).toBe(28);
    const rows = await page.evaluate(() => {
      const top = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().top;
      return {
        tabs: Math.abs(top('.app-chat-main-workspace [data-chat-destination-tabs]') - top('[data-chat-side-agent-panel] [data-chat-destination-tabs]')),
        titles: Math.abs(top('.app-native-titlebar-title .app-chat-pane-title-row') - top('.app-native-companion-titlebar .app-chat-pane-title-row')),
      };
    });
    expect(rows.tabs).toBeLessThan(1);
    expect(rows.titles).toBeLessThan(1);
    await page.getByRole('navigation', { name: 'Ask Agent destinations' }).getByRole('tab', { name: 'Tasks', exact: true }).click();
    await expect(page.locator('#chat-companion-tasks-panel')).toBeVisible();
    await page.mouse.move(0, 0);
    await expect.poll(() => page.evaluate(() => getComputedStyle(
      document.querySelector('[data-chat-side-agent-panel] [role="tab"][aria-selected="true"]')!, '::after',
    ).backgroundColor)).toBe(side.activeUnderline);
    await page.screenshot({ path: testInfo.outputPath(`companion-header-parity-native-${appearance}.png`) });
    expect(errors).toEqual([]);
  });
}

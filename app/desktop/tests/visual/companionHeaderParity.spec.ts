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
  // A chat theme switch transitions the tab colors: read until two consecutive samples of both headers agree.
  let previous = '';
  let main = await headerStyle(page, ...selectors.main);
  let side = await headerStyle(page, ...selectors.panel);
  await expect.poll(async () => {
    main = await headerStyle(page, ...selectors.main);
    side = await headerStyle(page, ...selectors.panel);
    const sample = JSON.stringify([main, side]);
    const settled = sample === previous;
    previous = sample;
    return settled;
  }, { timeout: 5000, intervals: [80] }).toBe(true);
  expect(main.tabLabels).toEqual(tabs);
  expect(side).toEqual(main);
  expect(side.activeUnderline).not.toBe(side.inactiveUnderline);
  return side;
}

/** The tab rows meet at the shared hairline divider with no body background between them. */
async function expectContinuousDivider(page: Page, headerSelector: string) {
  const measure = () => page.evaluate((headerSelector) => {
    const box = (selector: string) => {
      const { left, right, top, bottom } = document.querySelector(selector)!.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    const mainHeader = document.querySelector(`.app-chat-main-workspace ${headerSelector}`)!;
    const divider = document.querySelector('.app-chat-split-divider')!;
    return {
      main: box(`.app-chat-main-workspace ${headerSelector}`),
      panel: box(`[data-chat-side-agent-panel] ${headerSelector}`),
      divider: box('.app-chat-split-divider'),
      borderColor: getComputedStyle(mainHeader).borderBottomColor,
      panelBorderColor: getComputedStyle(document.querySelector(`[data-chat-side-agent-panel] ${headerSelector}`)!).borderBottomColor,
      borderWidth: getComputedStyle(mainHeader).borderBottomWidth,
      dividerColor: getComputedStyle(divider).backgroundColor,
    };
  }, headerSelector);
  // Let the panel's opening motion settle before comparing edges.
  await expect.poll(async () => {
    const { main, panel, divider } = await measure();
    return Math.abs(divider.left - main.right) < 0.5 && Math.abs(panel.left - divider.right) < 0.5
      && divider.right - divider.left > 0.5;
  }, { timeout: 5000 }).toBe(true);
  const seam = await measure();
  expect(seam.borderWidth).toBe('1px');
  expect(seam.panelBorderColor).toBe(seam.borderColor);
  // The main row's border ends exactly where the hairline starts, and the panel's begins where it ends.
  expect(Math.abs(seam.divider.left - seam.main.right)).toBeLessThan(0.5);
  expect(Math.abs(seam.panel.left - seam.divider.right)).toBeLessThan(0.5);
  expect(seam.divider.right - seam.divider.left).toBeLessThanOrEqual(1);
  expect(seam.panel.left - seam.main.right).toBeLessThanOrEqual(1);
  expect(Math.abs(seam.main.bottom - seam.panel.bottom)).toBeLessThan(0.5);
  expect(seam.divider.top).toBeLessThanOrEqual(seam.main.top);
  expect(seam.dividerColor).toBe(seam.borderColor);
  return seam;
}

/** Inactive tabs carry no pill unless hovered, and hover matches the main chat. */
async function expectTabHoverParity(page: Page) {
  await page.mouse.move(0, 0);
  const resting = await page.evaluate(() => Array.from(
    document.querySelectorAll('[data-chat-destination-tabs] [role="tab"][aria-selected="false"]'),
    (tab) => getComputedStyle(tab).backgroundColor,
  ));
  expect(new Set(resting)).toEqual(new Set(['rgba(0, 0, 0, 0)']));
  const hoverBackground = async (scope: string) => {
    await page.locator(`${scope} [data-chat-destination-tab="tasks"]`).hover();
    // Wait out the 140ms color transition: read until two samples agree.
    return page.evaluate(async (scope) => {
      const tab = document.querySelector(`${scope} [data-chat-destination-tab="tasks"]`)!;
      const read = () => getComputedStyle(tab).backgroundColor;
      const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
      await new Promise((resolve) => setTimeout(resolve, 400));
      let previous = read();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await pause();
        const next = read();
        if (next === previous) return next;
        previous = next;
      }
      return previous;
    }, scope);
  };
  const mainHover = await hoverBackground(mainPane);
  expect(mainHover).not.toMatch(/^(rgba\(0, 0, 0, 0\)|oklab\(0 0 0 \/ 0\))$/);
  expect(await hoverBackground(panel)).toBe(mainHover);
  await page.mouse.move(0, 0);
}

for (const appearance of ['light', 'dark'] as const) {
  test(`${appearance}: Ask Agent header and tabs match the main chat`, async ({ page }, testInfo) => {
    const errors = await openPanel(page, `theme=${appearance}&native=0`);
    const header = page.locator(`${panel} .app-chat-pane-header`);
    await expect(header.getByRole('heading')).toHaveText('Ask Agent · Fix transcript scroll jitter');
    await expect(header.getByRole('button', { name: 'Side chat options' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Close side chat' })).toBeVisible();
    await expectMatchingHeaders(page, inPaneSelectors);
    await expectContinuousDivider(page, '.app-chat-pane-header');
    await expectTabHoverParity(page);
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
    // Both title rows are painted by the one native title bar, at the same height.
    const titleRows = await page.evaluate(() => {
      const describe = (selector: string) => {
        const row = document.querySelector<HTMLElement>(selector)!;
        let painter: HTMLElement | null = row;
        while (painter && getComputedStyle(painter).backgroundColor === 'rgba(0, 0, 0, 0)') painter = painter.parentElement;
        const { top, height } = row.getBoundingClientRect();
        return { own: getComputedStyle(row).backgroundColor, top, height, painter: painter?.className, paint: painter ? getComputedStyle(painter).backgroundColor : null };
      };
      return {
        main: describe('.app-native-titlebar-main'),
        panel: describe('.app-native-companion-titlebar .app-chat-pane-header'),
      };
    });
    expect(titleRows.panel).toEqual(titleRows.main);
    expect(titleRows.main.painter).toBe('app-native-titlebar');
    expect(titleRows.main.own).toBe('rgba(0, 0, 0, 0)');
    await expectContinuousDivider(page, '.app-chat-native-metadata-header');
    await expectTabHoverParity(page);
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

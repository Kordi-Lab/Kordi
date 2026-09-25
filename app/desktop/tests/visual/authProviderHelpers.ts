import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';

// Shared steps for the provider-configuration specs. They drive the synthetic,
// offline AuthPreview fixture and its simulated OMP sign-in sessions.
export type CatalogPayload = {
  version: string;
  providers: Array<{
    id: string;
    models: string[];
    defaultModel: string | null;
    auth: { name: string };
    login: { name: string; instructions: string | null; authUrl: string | null; placeholder: string | null; envVars: string[] };
  }>;
};

export const catalog = JSON.parse(readFileSync(
  new URL('../../../../shared/omp-catalog/omp-provider-catalog.json', import.meta.url),
  'utf8',
)) as CatalogPayload;
export const ompProvider = (id: string) => {
  const entry = catalog.providers.find((provider) => provider.id === id);
  if (!entry) throw new Error(`The pinned OMP catalog has no ${id} provider.`);
  return entry;
};
// List rows use the short name; the full OMP name appears once, in the detail header.
export const shortName = (name: string) => name.replace(/\s*\([^()]*\)$/, '').replace(/\s+[A-Za-z+]+(?:\/[A-Za-z+]+)+$/, '');
export const anthropicName = ompProvider('anthropic').auth.name;
export const googleName = ompProvider('google').auth.name;
export const defaultModel = (id: string) => {
  const { models, defaultModel: preferred } = ompProvider(id);
  return preferred && models.includes(preferred) ? preferred : models[0];
};
export const secretLikeText = /token|secret|bearer|sk-|profile:|preview-(work|personal)/i;
export const callbackHint = "After you approve in the browser it will land on a localhost page that cannot load. Copy that page's full address and paste it here.";
// ChatGPT sign-in (OMP openai-codex) and API keys (OMP openai) share one OpenAI row.
export const expectedProviderRows = 72;

export async function openPreview(page: Page, variant: 'settings' | 'start' | 'login', options: { theme?: 'light' | 'dark'; provider?: string; method?: string; flags?: string[] } = {}) {
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.origin !== 'http://127.0.0.1:4174') offOrigin.push(url.href);
  });
  const provider = options.provider ? `&provider=${encodeURIComponent(options.provider)}` : '';
  const method = options.method ? `&method=${encodeURIComponent(options.method)}` : '';
  const flags = (options.flags ?? []).map((flag) => `&${flag}=1`).join('');
  await page.goto(`/tests/visual/authProviderConfig.html?variant=${variant}&theme=${options.theme ?? 'dark'}${provider}${method}${flags}`);
  await expect(page.getByRole('button', { name: /^Back( to providers)?$/ }).or(page.getByRole('textbox', { name: 'Search providers' }))).toBeVisible();
  return offOrigin;
}

export const providerRows = (page: Page) => page.getByRole('region', { name: /^(Connected|#|[A-Z]) providers$/ }).getByRole('button');
export const providerRow = (page: Page, label: string) => providerRows(page).filter({ has: page.getByText(label, { exact: true }) });
export const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
export const account = (page: Page, name: string) => section(page, 'Saved accounts').getByRole('group', { name, exact: true });
export const detail = (page: Page) => page.locator('[data-auth-provider-detail-column], .app-auth-provider-detail-shell');
export const heading = (page: Page) => page.getByRole('heading', { level: 1 });
export const pickerRows = (page: Page) => detail(page).locator('.app-auth-add-method-row');
export const steps = (page: Page) => section(page, 'Steps');
export const signedIn = (page: Page, name: string) => steps(page).getByText(`Signed in as ${name}`, { exact: true });
export const startChat = (page: Page) => page.getByRole('button', { name: 'Start chat', exact: true });
export const chatNotice = (page: Page, model: string | null, cloudProvider?: string) => page.getByText(
  `Chat would start with ${model ?? 'the default model'}${cloudProvider ? ` on Kordi Cloud (${cloudProvider} account)` : ''}.`,
);

/** OMP's dialog never repeats itself: consecutive step rows carry different descriptions. */
export async function expectDistinctStepDescriptions(page: Page) {
  const descriptions = (await steps(page).locator('[data-settings-row-description]').allInnerTexts()).map((text) => text.trim());
  expect(descriptions.length).toBeGreaterThan(1);
  descriptions.slice(1).forEach((text, index) => expect(text, `step ${index + 2} repeats step ${index + 1}`).not.toBe(descriptions[index]));
}

export async function openAddAccount(page: Page) {
  await detail(page).getByRole('button', { name: /^Add account/ }).click();
}

/** The provider page is back with the new account highlighted, in view, and ready to chat. */
export async function expectReturnedWith(page: Page, name: string) {
  await expect(page.getByRole('button', { name: 'Back to providers' })).toBeVisible();
  await expect(account(page, name).getByText('Added', { exact: true })).toBeVisible();
  await expect(account(page, name)).toBeInViewport();
  await expect(startChat(page)).toBeEnabled();
}

/** A finished sign-in shows its result, then returns to the provider page on its own. */
export async function finishAndReturn(page: Page, name: string) {
  await expect(signedIn(page, name)).toBeVisible();
  await expectReturnedWith(page, name);
}

export async function openProvider(page: Page, query: string, label: string, heading = label) {
  await page.getByRole('textbox', { name: 'Search providers' }).fill(query);
  await providerRow(page, label).click();
  await expect(page.getByRole('button', { name: 'Back to providers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
}

export async function expectMergedCatalogList(page: Page) {
  const placeholder = await page.getByRole('textbox', { name: 'Search providers' }).getAttribute('placeholder');
  const count = Number(placeholder?.match(/^Search (\d+) providers$/)?.[1]);
  expect(count).toBe(expectedProviderRows);
  await expect(providerRows(page)).toHaveCount(count);
  await expect(page.getByText(`OMP catalog ${catalog.version}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/could not load/i)).toHaveCount(0);
  await expect(section(page, 'Connected providers').getByRole('button')).toHaveText([/OpenAI/]);
  return count;
}

export async function selectOptions(select: Locator) {
  return select.locator('option').allTextContents();
}

/** Images on screen and web fonts have loaded, so a screenshot shows the final page. */
export async function waitForImagesAndFonts(page: Page) {
  // Offscreen logos load lazily and are not in the screenshot; waiting on them would hang.
  await page.evaluate(() => Promise.all([...document.images]
    .filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0;
    })
    // Loaded is not painted: decode each logo so the capture never races its first frame.
    .map((image) => (image.complete
      ? image.decode().catch(() => undefined)
      : new Promise((resolve) => { image.onload = resolve; image.onerror = resolve; }).then(() => image.decode().catch(() => undefined))))));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** The catalog chunk has arrived: final count, no loading text, rows and logos rendered. */
export async function waitForLoadedProviderList(page: Page) {
  await expect(page.getByRole('textbox', { name: 'Search providers' })).toHaveAttribute('placeholder', `Search ${expectedProviderRows} providers`);
  await expect(page.getByText('Loading providers…')).toHaveCount(0);
  await expect(providerRows(page).first()).toBeVisible();
  await waitForImagesAndFonts(page);
}

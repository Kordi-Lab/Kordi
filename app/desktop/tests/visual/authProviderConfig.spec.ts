import { expect, test } from '@playwright/test';
import {
  catalog, ompProvider, shortName, anthropicName, googleName, defaultModel,
  secretLikeText, callbackHint, openPreview, providerRows, providerRow, section,
  account, detail, heading, pickerRows, steps, signedIn,
  startChat, chatNotice, expectDistinctStepDescriptions, openAddAccount, expectReturnedWith, finishAndReturn,
  openProvider, expectMergedCatalogList, selectOptions, waitForImagesAndFonts, waitForLoadedProviderList,
} from './authProviderHelpers';

// Walks the provider-configuration acceptance flow against the synthetic,
// offline AuthPreview fixture and its simulated OMP sign-in sessions. It
// proves layout and interaction only: no account signs in and no model runs.

test('settings list shows connected providers first, then the merged OMP catalog A to Z', async ({ page }) => {
  const offOrigin = await openPreview(page, 'settings');
  const count = await expectMergedCatalogList(page);
  await expect(providerRow(page, 'OpenAI')).toContainText('2 accounts saved');
  await expect(providerRow(page, 'Groq')).toContainText(`API key · ${ompProvider('groq').models.length} models`);
  await expect(providerRow(page, 'Antigravity')).toContainText(`Gemini 3, Claude, GPT-OSS · Browser sign-in · ${ompProvider('google-antigravity').models.length} models`);
  for (const label of ['Anthropic', googleName, 'Custom API', 'LM Studio', 'Ollama']) await expect(providerRow(page, label)).toHaveCount(1);
  await expect(providerRow(page, 'ChatGPT')).toHaveCount(0);
  await expect(providerRows(page).filter({ hasText: anthropicName })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Provider index' }).getByRole('button', { name: 'Jump to A providers' })).toBeVisible();

  const search = page.getByRole('textbox', { name: 'Search providers' });
  const cases: Array<[string, string, number | null]> = [
    ['chatgpt', 'OpenAI', 1], ['anthropic', 'Anthropic', null], ['gemini', googleName, null],
    ['custom api', 'Custom API', 1], ['cerebras', shortName(ompProvider('cerebras').auth.name), 1],
  ];
  for (const [query, label, rows] of cases) {
    await search.fill(query);
    await expect(providerRow(page, label)).toBeVisible();
    if (rows !== null) await expect(providerRows(page)).toHaveCount(rows);
  }
  await search.fill('no-such-provider');
  await expect(providerRows(page)).toHaveCount(0);
  await expect(page.getByText('No providers match “no-such-provider”.')).toBeVisible();
  await search.fill('');
  await expect(providerRows(page)).toHaveCount(count);
  expect(offOrigin).toEqual([]);
});

test('OpenAI: the provider page has no inputs, the picker lists four methods, and accounts can be managed and tested', async ({ page }) => {
  const offOrigin = await openPreview(page, 'settings');
  await openProvider(page, 'openai', 'OpenAI');

  await expect(detail(page).locator('input')).toHaveCount(0);
  await expect(account(page, 'Work')).toContainText('ChatGPT · On this Mac');
  await expect(account(page, 'Personal')).toContainText('ChatGPT · On this Mac');
  await expect(account(page, 'Work').getByText('Active', { exact: true })).toBeVisible();
  await expect(detail(page).getByRole('button', { name: /^Add account/ })).toContainText('Browser sign-in, device code, on this Mac, API key');

  // Layer 2: the method picker.
  await openAddAccount(page);
  await expect(heading(page)).toHaveText('Add OpenAI account');
  await expect(pickerRows(page)).toHaveText([/^ChatGPT browser sign-in/, /^ChatGPT device code/, /^ChatGPT on this Mac/, /^API key/]);
  await expect(detail(page).locator('input')).toHaveCount(0);

  // Kordi's local adapter adds a third profile and returns to the provider page.
  await pickerRows(page).filter({ hasText: 'ChatGPT on this Mac' }).click();
  await expect(account(page, 'Sign-in account 3')).toBeVisible();
  for (const name of ['Work', 'Personal']) await expect(account(page, name)).toBeVisible();

  await account(page, 'Personal').getByRole('button', { name: 'Use this profile' }).click();
  await expect(account(page, 'Personal').getByText('Active', { exact: true })).toBeVisible();
  await expect(account(page, 'Work').getByText('Active', { exact: true })).toHaveCount(0);
  await account(page, 'Sign-in account 3').getByRole('button', { name: 'Remove' }).click();
  await account(page, 'Sign-in account 3').getByRole('button', { name: 'Confirm remove' }).click();
  await expect(account(page, 'Sign-in account 3')).toHaveCount(0);
  for (const name of ['Work', 'Personal']) await expect(account(page, name)).toBeVisible();

  // Layer 3: a hosted API key.
  await openAddAccount(page);
  await pickerRows(page).filter({ hasText: /^API key/ }).click();
  await expect(heading(page)).toHaveText('API key · OpenAI');
  await detail(page).getByRole('textbox', { name: 'Account name' }).fill('Billing key');
  await detail(page).getByLabel('API key', { exact: true }).fill('preview-openai-value');
  await detail(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(steps(page).getByText('Verifying with OMP…')).toBeVisible();
  await finishAndReturn(page, 'Billing key');
  await expect(account(page, 'Billing key')).toContainText('API key · Hosted in your Kordi account');

  const routeTest = section(page, 'Test route');
  const providerSelect = routeTest.getByRole('combobox', { name: 'Provider' });
  const accountSelect = routeTest.getByRole('combobox', { name: 'Account' });
  const modelSelect = routeTest.getByRole('combobox', { name: 'Model' });
  const codex = ompProvider('openai-codex');
  const openAiApi = ompProvider('openai');
  expect(await selectOptions(providerSelect)).toEqual(['ChatGPT', 'OpenAI']);
  expect(await selectOptions(accountSelect)).toEqual(['Work', 'Personal']);
  expect(await selectOptions(modelSelect)).toEqual(codex.models);
  await expect(routeTest.getByRole('combobox', { name: 'Thinking' })).toHaveValue('medium');
  const codexModel = codex.models.find((id) => id !== codex.defaultModel) ?? codex.models[0];
  await accountSelect.selectOption({ label: 'Work' });
  await modelSelect.selectOption(codexModel);
  await routeTest.getByRole('button', { name: 'Test route' }).click();
  await expect(routeTest.getByRole('button', { name: 'Testing…' })).toBeDisabled();
  const result = routeTest.getByRole('status');
  await expect(result).toContainText(`OMP confirmed · Work · openai-codex/${codexModel}`);
  expect(await result.innerText()).not.toMatch(secretLikeText);

  await providerSelect.selectOption({ label: 'OpenAI' });
  expect(await selectOptions(accountSelect)).toEqual(['Billing key']);
  expect(await selectOptions(modelSelect)).toEqual(openAiApi.models);
  const apiModel = openAiApi.models.find((id) => !codex.models.includes(id)) ?? openAiApi.models[0];
  await modelSelect.selectOption(apiModel);
  await routeTest.getByRole('combobox', { name: 'Thinking' }).selectOption('high');
  await routeTest.getByRole('button', { name: 'Test route' }).click();
  await expect(result).toContainText(`OMP confirmed · Billing key · openai/${apiModel}`);
  expect(await result.innerText()).not.toMatch(secretLikeText);

  await account(page, 'Billing key').getByRole('button', { name: 'Remove' }).click();
  await account(page, 'Billing key').getByRole('button', { name: 'Confirm remove' }).click();
  await expect(account(page, 'Billing key')).toHaveCount(0);
  expect(offOrigin).toEqual([]);
});

test('pickers follow OMP: Anthropic offers two methods, a single method skips the picker', async ({ page }) => {
  await openPreview(page, 'settings');
  await openProvider(page, 'anthropic', 'Anthropic', anthropicName);
  await openAddAccount(page);
  await expect(heading(page)).toHaveText('Add Anthropic account');
  await expect(pickerRows(page)).toHaveText([/^Browser sign-in/, /^API key/]);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Back to providers' }).click();

  await openProvider(page, 'groq', 'Groq');
  await openAddAccount(page);
  await expect(heading(page)).toHaveText('API key · Groq');
  await expect(pickerRows(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(heading(page)).toHaveText('Groq');
});

test('the provider name appears once and sign-in is not repeated', async ({ page }) => {
  await openPreview(page, 'settings');
  const fullName = ompProvider('google-antigravity').auth.name;
  await openProvider(page, 'antigravity', 'Antigravity', fullName);
  const text = await detail(page).innerText();
  expect(text.split(fullName).length - 1).toBe(1);
  expect((text.match(/Sign in/g) ?? []).length).toBeLessThanOrEqual(2);
  await expect(detail(page).getByRole('button', { name: /^Add account/ })).toContainText('Browser sign-in');
  await openAddAccount(page);
  await expect(heading(page)).toHaveText('Browser sign-in · Antigravity');
  const loginText = await detail(page).innerText();
  expect(loginText.includes(fullName)).toBe(false);
  expect((loginText.match(/Sign in/g) ?? []).length).toBeLessThanOrEqual(2);
});

test('api-key login shows OMP instructions, the key link and placeholder, then saves', async ({ page }) => {
  const cerebras = ompProvider('cerebras');
  const offOrigin = await openPreview(page, 'login', { provider: 'cerebras' });
  await expect(heading(page)).toHaveText('API key · Cerebras');
  await expect(detail(page)).toContainText(cerebras.login.instructions!);
  const key = detail(page).getByLabel('API key', { exact: true });
  await expect(key).toHaveAttribute('placeholder', cerebras.login.placeholder!);
  await expect(key).toHaveAttribute('type', 'password');
  await detail(page).getByRole('link', { name: 'Get an API key' }).click();
  await expect(page.getByText(`The sign-in page would open: ${cerebras.login.authUrl}`, { exact: false })).toBeVisible();
  await detail(page).getByRole('textbox', { name: 'Account name' }).fill('Research');
  await key.fill('preview-cerebras-value');
  await detail(page).getByRole('button', { name: 'Save', exact: true }).click();
  await finishAndReturn(page, 'Research');
  await expect(account(page, 'Research')).toContainText('API key · Hosted in your Kordi account');
  await expect(account(page, 'Research').getByText('Active', { exact: true })).toBeVisible();
  await startChat(page).click();
  await expect(chatNotice(page, `cerebras/${defaultModel('cerebras')}`, 'cerebras')).toBeVisible();
  expect(offOrigin).toEqual([]);
});

test('env-only login keeps the field open after OMP rejects a value', async ({ page }) => {
  const groq = ompProvider('groq');
  await openPreview(page, 'login', { provider: 'groq' });
  const key = detail(page).getByLabel('API key', { exact: true });
  await expect(key).toHaveAttribute('placeholder', groq.login.envVars[0]);
  await key.fill('invalid-value');
  await detail(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(detail(page).getByRole('alert')).toHaveText('OMP did not accept that value. Check it and try again.');
  await key.fill('preview-groq-value');
  await detail(page).getByRole('button', { name: 'Save', exact: true }).click();
  await finishAndReturn(page, 'Work');
});

test('oauth-code login appends the sign-in link, the pasted code, progress and the result in order', async ({ page }) => {
  // Another sign-in holds the localhost port, so Kordi cannot capture the redirect and asks for a paste.
  await openPreview(page, 'login', { provider: 'anthropic', method: 'browser', flags: ['captureBusy'] });
  await expect(heading(page)).toHaveText('Browser sign-in · Anthropic');
  await detail(page).getByRole('textbox', { name: 'Account name' }).fill('Studio');
  await detail(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('The sign-in page would open: https://sign-in.example/authorize/anthropic')).toBeVisible();
  await expect(steps(page).getByRole('button', { name: 'Open sign-in page' })).toBeVisible();
  await expect(steps(page).getByText('https://sign-in.example/authorize/anthropic', { exact: true })).toBeVisible();
  const paste = steps(page).getByRole('textbox', { name: 'Redirect URL or code' });
  await expect(paste).toBeVisible();
  await expect(steps(page).getByText(/^Port \d+ is in use on this Mac\. Close the program using it, or paste the callback link below\.$/)).toBeVisible();
  await expectDistinctStepDescriptions(page);
  await paste.fill('https://sign-in.example/callback?code=preview');
  await steps(page).getByRole('button', { name: 'Continue' }).click();
  await expect(signedIn(page, 'Studio')).toBeVisible();
  const order = await steps(page).innerText();
  const positions = ['Sign-in page', 'Link', 'https://sign-in.example/callback?code=preview', 'Finishing sign-in', 'Signed in as Studio'].map((text) => order.indexOf(text));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  await finishAndReturn(page, 'Studio');
  await expect(account(page, 'Studio')).toContainText('Browser sign-in · Hosted in your Kordi account');
});

test('a ChatGPT browser sign-in finishes on its own when the browser lands on localhost', async ({ page }) => {
  const offOrigin = await openPreview(page, 'login', { provider: 'openai-codex', method: 'browser' });
  await expect(heading(page)).toHaveText('Browser sign-in · ChatGPT');
  await detail(page).getByRole('textbox', { name: 'Account name' }).fill('Studio');
  await detail(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('The sign-in page would open: https://sign-in.example/authorize/openai-codex')).toBeVisible();
  await expect(steps(page).getByText('Sign-in received from the browser', { exact: true })).toBeVisible();
  await expect(signedIn(page, 'Studio')).toBeVisible();
  expect(await steps(page).innerText()).not.toMatch(/localhost|code=|Redirect URL or code/);
  await expect(page.getByText(callbackHint)).toHaveCount(0);
  await expectReturnedWith(page, 'Studio');
  await expect(account(page, 'Studio')).toContainText('ChatGPT · Hosted in your Kordi account');
  expect(offOrigin).toEqual([]);
});

test('device-code login shows the code large and Escape cancels it', async ({ page }) => {
  await openPreview(page, 'login', { provider: 'kimi-code' });
  await expect(heading(page)).toHaveText('Device code · Kimi Code');
  await detail(page).getByRole('button', { name: 'Show code' }).click();
  await expect(steps(page).getByText('PRVW-2468', { exact: true })).toBeVisible();
  await expect(steps(page).getByRole('button', { name: 'Copy code' })).toBeVisible();
  await expect(steps(page).getByRole('button', { name: 'Open sign-in page' })).toBeVisible();
  await expect(steps(page).getByRole('status')).toHaveText(/Waiting for you to finish on the provider page/);
  await expectDistinctStepDescriptions(page);
  await page.keyboard.press('Escape');
  await expect(steps(page).getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(steps(page).getByRole('button', { name: 'Start again' })).toBeVisible();
});

test('vendor-token login asks the OMP prompt with masked entry and keeps the secret hidden', async ({ page }) => {
  await openPreview(page, 'login', { provider: 'cloudflare-ai-gateway', method: 'vendor-token' });
  await expect(heading(page)).toHaveText(`Vendor token · ${shortName(ompProvider('cloudflare-ai-gateway').auth.name)}`);
  await detail(page).getByRole('button', { name: 'Continue' }).click();
  await expect(steps(page).getByText('e.g., tok_…', { exact: true })).toBeVisible();
  await expect(steps(page).locator('[data-settings-row-description]').filter({ hasText: /^Paste your access token/ })).toBeVisible();
  const secret = steps(page).getByLabel('Paste your access token');
  await expect(secret).toHaveAttribute('type', 'password');
  await secret.fill('preview-gateway-value');
  await steps(page).getByRole('button', { name: 'Continue' }).click();
  await expect(signedIn(page, 'Work')).toBeVisible();
  await expect(steps(page).getByText('Entered', { exact: true })).toBeVisible();
  await expectDistinctStepDescriptions(page);
  await expect(steps(page).getByText('preview-gateway-value')).toHaveCount(0);
  await finishAndReturn(page, 'Work');
  await expect(account(page, 'Work')).toContainText('Vendor token · Hosted in your Kordi account');
});

test('Anthropic API keys start the api-key method', async ({ page }) => {
  await openPreview(page, 'login', { provider: 'anthropic', method: 'api-key' });
  await expect(heading(page)).toHaveText('API key · Anthropic');
  await detail(page).getByRole('textbox', { name: 'Account name' }).fill('Billing');
  await detail(page).getByLabel('API key', { exact: true }).fill('preview-anthropic-value');
  await detail(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(steps(page).getByText('Verifying with OMP…')).toBeVisible();
  await expect(signedIn(page, 'Billing')).toBeVisible();
  await expect(steps(page).getByRole('button')).toHaveText(['Start chat', 'Done']);
  await steps(page).getByRole('button', { name: 'Start chat' }).click();
  await expect(chatNotice(page, `anthropic/${defaultModel('anthropic')}`, 'anthropic')).toBeVisible();
  await expectReturnedWith(page, 'Billing');
  await expect(account(page, 'Billing')).toContainText('API key · Hosted in your Kordi account');
});

test('Custom API accounts carry a model: save one, chat with it, and add one to an older account', async ({ page }) => {
  await openPreview(page, 'settings', { provider: 'custom', flags: ['legacyCustom'] });
  await expect(account(page, 'Gateway')).toContainText('Add a model ID to start chatting');
  await expect(startChat(page)).toBeDisabled();
  await expect(startChat(page)).toHaveAttribute('title', 'Add a model ID to start chatting');

  await openAddAccount(page);
  await detail(page).getByRole('textbox', { name: 'Account name' }).fill('Team');
  await detail(page).getByRole('textbox', { name: 'API base URL' }).fill('https://api.example.com/v1');
  await detail(page).getByLabel('API key', { exact: true }).fill('preview-custom-value');
  // Save stays off until the model ID is entered too.
  await expect(detail(page).getByRole('button', { name: 'Save key' })).toBeDisabled();
  await detail(page).getByRole('textbox', { name: 'Model ID' }).fill('deepseek-chat');
  await expect(detail(page).getByRole('button', { name: 'Save key' })).toBeEnabled();
  await detail(page).getByRole('button', { name: 'Save key' }).click();
  await expect(heading(page)).toHaveText('Custom API');
  await expectReturnedWith(page, 'Team');
  await expect(account(page, 'Team')).toContainText('Custom API · deepseek-chat · Hosted in your Kordi account');
  await expect(page.getByText(/Key saved|Choose a model below/)).toHaveCount(0);
  // A hosted-only account's chat carries its route: it runs on Kordi Cloud, not on this Mac.
  await startChat(page).click();
  await expect(chatNotice(page, 'custom/deepseek-chat', 'custom')).toBeVisible();

  await account(page, 'Gateway').getByRole('button', { name: 'Edit' }).click();
  await expect(heading(page)).toHaveText('Edit account');
  await expect(detail(page).getByRole('textbox', { name: 'Account name' })).toHaveValue('Gateway');
  await detail(page).getByRole('textbox', { name: 'API base URL' }).fill('https://gateway.example.com/v1');
  await detail(page).getByRole('textbox', { name: 'Model ID' }).fill('qwen-plus');
  await detail(page).getByLabel('API key', { exact: true }).fill('preview-gateway-value');
  await detail(page).getByRole('button', { name: 'Save key' }).click();
  await expect(account(page, 'Gateway')).toContainText('Custom API · qwen-plus');
  await expect(account(page, 'Gateway')).not.toContainText('Add a model ID');
});

test('a completed ChatGPT device sign-in returns with the account added and ready to test', async ({ page }) => {
  const offOrigin = await openPreview(page, 'login', { provider: 'openai-codex-device', method: 'device' });
  await expect(heading(page)).toHaveText('Device code · ChatGPT');
  await detail(page).getByRole('textbox', { name: 'Account name' }).fill('Team');
  await detail(page).getByRole('button', { name: 'Show code' }).click();
  await expect(steps(page).getByText('PRVW-2468', { exact: true })).toBeVisible();
  await steps(page).getByRole('button', { name: 'Open sign-in page' }).click();
  await expect(steps(page).getByText(/Confirming sign-in/)).toBeVisible();
  await finishAndReturn(page, 'Team');
  await expect(account(page, 'Team')).toContainText('ChatGPT · Hosted in your Kordi account');
  for (const name of ['Work', 'Personal']) await expect(account(page, name)).toBeVisible();
  expect(await selectOptions(section(page, 'Test route').getByRole('combobox', { name: 'Account' }))).toEqual(['Work', 'Personal', 'Team']);
  expect(offOrigin).toEqual([]);
});

test('a session routed to a removed account shows it as unavailable and blocks send until another account is chosen', async ({ page }) => {
  await openPreview(page, 'settings', { provider: 'openai', flags: ['missingAccount'] });
  const session = section(page, 'Agent session');
  await expect(session.getByRole('status')).toContainText('Account unavailable');
  await expect(session.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(session.getByRole('button', { name: 'Test route' })).toBeDisabled();
  await session.getByRole('button', { name: 'model route · Account unavailable' }).click();
  const menu = page.getByRole('dialog', { name: 'Agent model' });
  await expect(menu).toContainText('account unavailable');
  await expect(menu.getByRole('button', { name: 'save' })).toBeDisabled();
  await menu.getByText('provider', { exact: true }).click();
  await menu.getByRole('button', { name: /^chatgpt\s*work/ }).click();
  await expect(menu.getByRole('button', { name: 'save' })).toBeEnabled();
  await menu.getByRole('button', { name: 'save' }).click();
  await expect(session.getByRole('status')).toHaveCount(0);
  await expect(session.getByRole('button', { name: 'Send' })).toBeEnabled();
  await expect(session.getByRole('button', { name: 'model route', exact: true })).toBeVisible();
});

test('the composer lists every hosted account to run on Kordi Cloud, and a local account returns to this Mac', async ({ page }) => {
  await openPreview(page, 'settings', { provider: 'openai', flags: ['hostedAccounts'] });
  const session = section(page, 'Agent session');
  const caption = session.getByText('Runs on Kordi Cloud', { exact: true });
  await expect(caption).toHaveCount(0);
  const openProviders = async () => {
    await session.getByRole('button', { name: 'model route', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Agent model' });
    await menu.getByText('provider', { exact: true }).click();
    return menu;
  };
  let menu = await openProviders();
  for (const [name, detail] of [['research', /cerebras · runs on kordi cloud/], ['team', /chatgpt · runs on kordi cloud/], ['gateway', /custom api · runs on kordi cloud/]] as const) {
    await expect(menu.getByRole('button', { name: new RegExp(`^${name}`) })).toContainText(detail);
  }
  const reconnect = menu.getByRole('button', { name: /^old laptop/ });
  await expect(reconnect).toBeDisabled();
  await expect(reconnect).toHaveAttribute('title', 'Account needs reconnecting');
  await expect(reconnect).toContainText('account needs reconnecting');

  // A hosted account applies its Kordi Cloud route with its provider's catalog models.
  await menu.getByRole('button', { name: /^research/ }).click();
  await menu.getByRole('button', { name: 'save' }).click();
  await expect(caption).toBeVisible();
  await expect(session).toContainText(`cerebras/${ompProvider('cerebras').models[0]} on cloud-api-key:preview-research`);

  menu = await openProviders();
  await menu.getByRole('button', { name: /^gateway/ }).click();
  await menu.getByRole('button', { name: 'save' }).click();
  await expect(session).toContainText('custom/deepseek-chat on cloud-api-key:preview-gateway');

  menu = await openProviders();
  await menu.getByRole('button', { name: /^chatgpt\s*work/ }).click();
  await menu.getByRole('button', { name: 'save' }).click();
  await expect(caption).toHaveCount(0);
});

test('a desktop sign-in whose hosted copy expired asks to reconnect', async ({ page }) => {
  await openPreview(page, 'settings', { provider: 'openai', flags: ['needsReconnect'] });
  await expect(account(page, 'Personal')).toContainText('Account needs reconnecting');
  await expect(account(page, 'Personal').getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await expect(account(page, 'Work').getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
});

test('the start gate renders the same rows for the list and provider detail', async ({ page }) => {
  const offOrigin = await openPreview(page, 'start');
  await expect(page.getByRole('heading', { name: 'Your providers' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to chat' })).toBeVisible();
  await expectMergedCatalogList(page);
  await openProvider(page, 'chatgpt', 'OpenAI');
  for (const name of ['Work', 'Personal']) await expect(account(page, name)).toBeVisible();
  await expect(section(page, 'Test route')).toBeVisible();
  await startChat(page).click();
  await expect(page.getByText(`The start gate closed. Chat would start with openai-codex/${defaultModel('openai-codex')}.`)).toBeVisible();
  await openAddAccount(page);
  await expect(pickerRows(page)).toHaveCount(4);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Back to providers' }).click();
  await expect(page.getByRole('heading', { name: 'Your providers' })).toBeVisible();
  expect(offOrigin).toEqual([]);
});


for (const theme of ['light', 'dark'] as const) {
  test(`settings OpenAI detail baseline (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1040 });
    await openPreview(page, 'settings', { theme });
    await openProvider(page, 'openai', 'OpenAI');
    await expect(section(page, 'Test route')).toBeVisible();
    await expect(page.getByText('Loading providers…')).toHaveCount(0);
    await waitForImagesAndFonts(page);
    await expect(page).toHaveScreenshot(`authProviderConfig-settings-${theme}.png`);
  });

  // The CI macOS runner lays the gate out a few pixels differently from a Mac,
  // so the start gate is checked by structure rather than a pixel baseline.
  test(`start gate provider list structure (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1040 });
    await openPreview(page, 'start', { theme });
    await expect(page.getByRole('heading', { name: 'Your providers', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to chat' })).toBeEnabled();
    await waitForLoadedProviderList(page);
    await expect(page.getByText(`OMP catalog ${catalog.version}`, { exact: true })).toBeVisible();
    await expect(section(page, 'Connected providers').getByRole('button')).toHaveText([/OpenAI/]);
    // The pinned catalog fixes the first A-group rows.
    await expect(section(page, 'A providers').getByRole('button').nth(0)).toContainText('Abliteration');
    await expect(section(page, 'A providers').getByRole('button').nth(1)).toContainText('ai&');
    await expect(section(page, 'A providers').getByRole('button').nth(2)).toContainText('AIML API');
    const index = page.getByRole('navigation', { name: 'Provider index' });
    await expect(index.getByRole('button', { name: 'Jump to A providers' })).toBeVisible();
    await expect(index.getByRole('button', { name: 'Jump to Z providers' })).toBeVisible();
  });
}

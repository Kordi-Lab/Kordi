import {test,expect} from '@playwright/test';

const sentCount = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as {sentSubsessionRequests:unknown[]}).sentSubsessionRequests.length);
const authRequests = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as {fixtureAuthRequests?:number}).fixtureAuthRequests ?? 0);

for (const accountId of ['owner','peer']) {
  test(`an unauthenticated ${accountId} ${accountId === 'owner' ? 'is asked to connect before asking its own agent' : 'can discuss a task but only peers can invoke its Cloud Agent'}`, async ({page}) => {
    await page.addInitScript(accountId => Object.assign(window,{fixtureAccountId:accountId,fixtureHasAuth:false}),accountId);
    await page.goto('/tests/visual/subsessionConversation.html');
    await page.getByRole('button',{name:'Open background agent session: Planet research'}).click();
    const panel = page.locator('[data-chat-side-agent-panel="true"]');
    const field = panel.getByRole('textbox');
    const send = panel.getByRole('button',{name:'Send to Planet research',exact:true});
    if (accountId === 'owner') {
      // In the owner's own background session a plain message addresses the
      // owner's agent, so it needs a provider and keeps the draft.
      await field.fill('Owner message without a provider');
      await send.click();
      await expect.poll(() => authRequests(page)).toBe(1);
      await expect(field).toContainText('Owner message without a provider');
      expect(await sentCount(page)).toBe(0);
      return;
    }
    await field.fill('Human discussion without a provider');
    await send.click();
    await expect(field).toHaveText('');
    await expect.poll(() => sentCount(page)).toBe(1);
    await field.pressSequentially('@Kordi');
    await page.getByRole('option').filter({hasText:"Alex's Kordi"}).click();
    await field.pressSequentially(' continue');
    await send.click();
    await expect.poll(() => sentCount(page)).toBe(2);
    await expect(field).toHaveText('');
    expect(await authRequests(page)).toBe(0);
  });
}

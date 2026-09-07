import {test,expect} from '@playwright/test';

for (const accountId of ['owner','peer']) {
  test(`an unauthenticated ${accountId} can discuss a task but only peers can invoke its Cloud Agent`, async ({page}) => {
    await page.addInitScript(accountId => Object.assign(window,{fixtureAccountId:accountId,fixtureHasAuth:false}),accountId);
    await page.goto('/tests/visual/subsessionConversation.html');
    await page.getByRole('button',{name:'Open background agent session: Planet research'}).click();
    const panel = page.locator('[data-chat-side-agent-panel="true"]');
    const field = panel.getByRole('textbox');
    const send = panel.getByRole('button',{name:'Send to Planet research',exact:true});
    await field.fill('Human discussion without a provider');
    await send.click();
    await expect(field).toHaveText('');
    await expect.poll(() => page.evaluate(() => (window as unknown as {sentSubsessionRequests:unknown[]}).sentSubsessionRequests.length)).toBe(1);
    await field.pressSequentially('@Kordi');
    await page.getByRole('option').filter({hasText:"Alex's Kordi"}).click();
    await field.pressSequentially(' continue');
    await send.click();
    if (accountId === 'owner') {
      await expect.poll(() => page.evaluate(() => (window as unknown as {fixtureAuthRequests:number}).fixtureAuthRequests)).toBe(1);
      await expect(field).toContainText('continue');
      expect(await page.evaluate(() => (window as unknown as {sentSubsessionRequests:unknown[]}).sentSubsessionRequests.length)).toBe(1);
    } else {
      await expect.poll(() => page.evaluate(() => (window as unknown as {sentSubsessionRequests:unknown[]}).sentSubsessionRequests.length)).toBe(2);
      await expect(field).toHaveText('');
      expect(await page.evaluate(() => (window as unknown as {fixtureAuthRequests?:number}).fixtureAuthRequests??0)).toBe(0);
    }
  });
}

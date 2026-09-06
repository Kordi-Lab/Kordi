import { test, expect } from '@playwright/test';

for (const account of ['owner', 'peer']) {
  test(`shared task instructions show the Agent for ${account}, with separate live progress`, async ({ page }, testInfo) => {
    await page.addInitScript(account => { (window as unknown as {fixtureAccountId:string}).fixtureAccountId = account; }, account);
    await page.goto('/tests/visual/subsessionConversation.html');
    await page.evaluate(() => {
      const record = (window as unknown as {fixtureSubsession: Record<string,unknown>}).fixtureSubsession;
      Object.assign(record, {hasFollowupExecution:false,version:2,messages:[
        {id:'brief',role:'user',senderAgentId:'fixture-agent',text:'Compare the sources in this shared Agent thread.',timestampMs:1000},
      ]});
    });
    await page.getByRole('button', { name: 'Open background agent session: Planet research' }).click();
    const panel = page.locator('[data-chat-side-agent-panel="true"]');
    await expect(panel.getByText('Compare the sources in this shared Agent thread.', {exact:true})).toBeVisible();
    await expect(panel.getByText("Alex's Kordi", {exact:true}).first()).toBeVisible();
    await expect(panel.getByText('Task', {exact:true})).toHaveCount(0);
    await expect(panel.getByText('Ta', {exact:true})).toHaveCount(0);
    await expect(panel.getByRole('textbox')).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('shared-task-instruction.png')});
  });
}

test('Tasks shows authoritative Agent thread entries and frozen execution time, and opens the same chat pane', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const host = window as unknown as {__TAURI_INTERNALS__: unknown; fixtureNativeCommands: string[]};
    host.fixtureNativeCommands = [];
    host.__TAURI_INTERNALS__ = {invoke: (command: string) => { host.fixtureNativeCommands.push(command); return Promise.resolve(null); }};
  });
  await page.goto('/tests/visual/subsessionConversation.html');
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  const task = page.locator('[data-agent-thread-task="fixture-child"]');
  await expect(page.locator('[data-agent-thread-task]')).toHaveCount(2);
  await expect(task).toContainText('Done · 1m 3s · Mac runtime');
  await expect(page.getByText('Awaiting human input.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Last reported as running/)).toBeVisible();
  await expect(page.getByText(/Running · \d/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('tasks.png') });
  await task.getByRole('button', { name: 'Open Agent thread: Planet research', exact: true }).click();
  const panel = page.locator('[data-chat-side-agent-panel="true"]');
  await expect(panel).toHaveAttribute('data-companion-session-id', 'fixture-child');
  await expect(panel.getByRole('textbox')).toBeVisible();
  await panel.getByRole('button', { name: 'Close side chat', exact: true }).click();
  await page.evaluate(() => {
    const task = (window as unknown as {fixtureAgentTasks: Record<string,unknown>[]}).fixtureAgentTasks[0];
    Object.assign(task,{status:'running',startedAtMs:Date.now()-2000,finishedAtMs:null,live:true});
  });
  await expect(task.locator('[data-agent-thread-status="Running"]')).toBeVisible();
  await page.evaluate(() => {
    const task = (window as unknown as {fixtureAgentTasks: Record<string,unknown>[]}).fixtureAgentTasks[0];
    Object.assign(task,{status:'done',startedAtMs:1000,finishedAtMs:4000,live:false});
  });
  await expect(task).toContainText('Done · 3s · Mac runtime');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as {fixtureNativeCommands:string[]}).fixtureNativeCommands)).toEqual([]);
});

test('private Ask Agent and shared Agent threads keep separate identities, avatars and drafts', async ({ page }) => {
  await page.goto('/tests/visual/subsessionConversation.html');
  await page.getByRole('button', { name: 'Ask Agent', exact: true }).click();
  const panel = page.locator('[data-chat-side-agent-panel="true"]');
  await expect(panel.getByText('Ask Agent · Private workspace', { exact: true })).toBeVisible();
  await expect(panel.getByText('Only you · Agent session', { exact: true })).toBeVisible();
  const field = panel.getByRole('textbox');
  await field.fill('PRIVATE_DRAFT_CANARY');
  await panel.getByRole('button', { name: 'Close side chat', exact: true }).click();
  await page.getByRole('button', { name: 'Open background agent session: Planet research' }).click();
  await expect(field).toHaveText('');
  await expect(panel.getByText('PRIVATE_HISTORY_CANARY')).toHaveCount(0);
  await field.pressSequentially('@');
  const member = page.getByRole('option').filter({ hasText: /^@Alex$/ });
  await expect(member).toBeVisible();
  await expect(page.getByRole('option').filter({ hasText: /^@Sam$/ })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Members', exact: true })).toBeVisible();
  const originalAvatar = await member.locator('img').getAttribute('src');
  await page.evaluate(() => {
    const fixture = window as unknown as {fixtureSubsession: {participants: {accountId:string;avatarUrl?:string}[]};fixtureAvatar:(color:string)=>string};
    fixture.fixtureSubsession.participants.find(item=>item.accountId==='owner')!.avatarUrl = fixture.fixtureAvatar('green');
  });
  await expect(member.locator('img')).not.toHaveAttribute('src', originalAvatar!);
  await field.fill('Shared member message');
  await panel.getByRole('button', { name: 'Send to Planet research', exact: true }).click();
  await expect(field).toHaveText('');
  await panel.getByRole('button', { name: 'Close side chat', exact: true }).click();
  await page.getByRole('button', { name: 'Ask Agent', exact: true }).click();
  await expect(field).toHaveText('PRIVATE_DRAFT_CANARY');
  await panel.getByRole('button', { name: 'Send to Private workspace', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {privateSends: {id:string;text:string}[]}).privateSends)).toMatchObject([{id:'private-session',text:'PRIVATE_DRAFT_CANARY'}]);
  expect(await page.evaluate(() => (window as unknown as {sentSubsessionRequests:{text:string}[]}).sentSubsessionRequests.map(item=>item.text))).toEqual(['Shared member message']);
  expect(await page.evaluate(() => (window as unknown as {unexpectedParentSends:number}).unexpectedParentSends)).toBe(0);
});

test('subsession has a bounded transcript, visible composer, and explicit identity-bound mentions', async ({ page }, testInfo) => {
  await page.goto('/tests/visual/subsessionConversation.html');
  await page.getByRole('button', { name: 'Open background agent session: Planet research' }).click();
  const panel = page.locator('[data-chat-side-agent-panel="true"]');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Parent conversation remains here.', { exact: true })).toBeVisible();
  const panelBounds = await panel.boundingBox();
  expect(panelBounds!.x).toBeGreaterThan(0);
  expect(panelBounds!.width).toBeLessThan(page.viewportSize()!.width);
  const field = panel.getByRole('textbox');
  await expect(panel.getByText('Agent thread · Planet research', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Shared with chat members/)).toBeVisible();
  await expect(panel.getByText(/Only you/)).toHaveCount(0);
  await expect(panel.getByText('Queued next', { exact: true })).toHaveCount(2);
  await expect(panel.locator('.app-queued-message').filter({ hasText: 'Owner queued follow' })).toContainText('Alex');
  await expect(field).toBeVisible();
  const bounds = await field.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThan(page.viewportSize()!.height);
  await field.fill('Hello everyone');
  await panel.getByRole('button', { name: 'Send to Planet research', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {sentSubsessionRequests: {mentions: unknown[]}[]}).sentSubsessionRequests[0]?.mentions.length)).toBe(0);
  await expect(field).toBeEditable();
  await expect(field).toHaveText('');
  await field.pressSequentially('@Kordi');
  await page.getByRole('option').filter({ hasText: "Alex's Kordi" }).click();
  await expect(field).toContainText('@KordiAlex');
  await page.evaluate(() => {
    const snapshot = (window as unknown as {fixtureSubsession: {agentDisplayName: string; version: number}}).fixtureSubsession;
    snapshot.agentDisplayName = 'Research Agent'; snapshot.version += 1;
  });
  await expect(panel.getByText(/Shared with chat members · Research Agent · Owner · Alex/)).toBeVisible();
  await field.pressSequentially(' continue');
  await panel.getByRole('button', { name: 'Send to Planet research', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {sentSubsessionRequests: unknown[]}).sentSubsessionRequests[1])).toEqual({ clientMessageId: expect.any(String), text: expect.stringMatching(/^@KordiAlex\s+continue$/), mentions: [expect.objectContaining({ agentId: 'fixture-agent' })] });
  await expect(page.getByText('processing...', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as {unexpectedParentSends:number}).unexpectedParentSends)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as {unexpectedNativePrefetches:number}).unexpectedNativePrefetches)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('conversation.png') });
  await page.evaluate(() => {
    const snapshot = (window as unknown as {fixtureSubsession: {status: string; version: number; messages: {requestState?: string}[]}}).fixtureSubsession;
    snapshot.status = 'done'; snapshot.version += 1;
    for (const message of snapshot.messages) if (message.requestState) message.requestState = 'completed';
  });
  await expect(page.locator('[data-related-agent-session-status="done"]')).toBeVisible();
  await panel.getByRole('button', { name: 'Close side chat', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Open background agent session: Planet research' }).click();
  await expect(panel.getByText('Hello everyone', { exact: true })).toBeVisible();
  await expect(panel).toHaveAttribute('data-companion-session-id', 'fixture-child');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('side-panel follow-up failures retain the draft and retry the same request identity', async ({ page }) => {
  await page.goto('/tests/visual/subsessionConversation.html');
  await page.getByRole('button', { name: 'Open background agent session: Planet research' }).click();
  const panel = page.locator('[data-chat-side-agent-panel="true"]');
  const field = panel.getByRole('textbox');
  await field.fill('Retry this member message');
  await page.evaluate(() => { (window as unknown as {failNextSubsessionSend:boolean}).failNextSubsessionSend = true; });
  await panel.getByRole('button', { name: 'Send to Planet research' }).click();
  await expect(panel.getByRole('alert')).toContainText('Could not send');
  await expect(field).toHaveText('Retry this member message');
  await panel.getByRole('button', { name: 'Send to Planet research' }).click();
  await expect(field).toHaveText('');
  const requests = await page.evaluate(() => (window as unknown as {sentSubsessionRequests: {clientMessageId:string}[]}).sentSubsessionRequests);
  expect(requests).toHaveLength(2);
  expect(requests[0].clientMessageId).toBe(requests[1].clientMessageId);
  expect(await page.evaluate(() => (window as unknown as {unexpectedParentSends:number}).unexpectedParentSends)).toBe(0);
});

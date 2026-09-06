import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: unknown;
      nativeCreateCalls: {command: string; args: {independent?: boolean; sourceSessionId?: string}}[];
      holdNativeCreate?: boolean;
      failNativeCreate?: boolean;
      finishNativeCreate?: () => void;
    };
    host.nativeCreateCalls = [];
    host.__TAURI_INTERNALS__ = { invoke: (command: string, args: {independent?: boolean; sourceSessionId?: string}) => {
      if (command !== 'desktop_chat_new_session') return Promise.reject(Error(`Unexpected command: ${command}`));
      host.nativeCreateCalls.push({ command, args });
      if (host.failNativeCreate) { host.failNativeCreate = false; return Promise.reject(Error('Creation failed')); }
      const id = `new-private-${host.nativeCreateCalls.length}`;
      const state = {activeSessionId:id,activeSession:{id,title:'New chat',messageCount:0,messages:[],draft:false},sessions:[]};
      return host.holdNativeCreate ? new Promise(resolve => { host.finishNativeCreate = () => resolve(state); }) : Promise.resolve(state);
    }};
  });
  await page.goto('/tests/visual/subsessionConversation.html');
  await page.getByRole('button', { name:'Ask Agent', exact:true }).click();
});

test('New chat creates a distinct private session and survives delayed catalog hydration', async ({ page }) => {
  const main = page.getByRole('tabpanel').filter({ has: page.getByRole('region', {name:'Conversation messages'}) }).first();
  await main.getByRole('textbox').fill('MAIN_DRAFT_KEEP');
  const panel = page.locator('[data-chat-side-agent-panel="true"]');
  await panel.getByRole('textbox').fill('OLD_PRIVATE_DRAFT_KEEP');
  await page.evaluate(() => { (window as unknown as {holdNewChatCatalog:boolean}).holdNewChatCatalog = true; });
  await panel.getByRole('button', {name:'Side chat options',exact:true}).click();
  await panel.getByRole('button', {name:'New chat',exact:true}).click();
  await expect(panel).toHaveAttribute('data-companion-session-id','new-private-1');
  await expect(panel.getByText('Ask Agent · New chat',{exact:true})).toBeVisible();
  await expect(panel.getByText('PRIVATE_HISTORY_CANARY',{exact:true})).toHaveCount(0);
  const field = panel.getByRole('textbox');
  await expect(field).toHaveText('');
  await field.fill('FIRST_NEW_PRIVATE_MESSAGE');
  await expect(panel.getByRole('button',{name:'Send to New chat',exact:true})).toBeDisabled();
  await page.evaluate(() => (window as unknown as {publishNewChatCatalog:()=>void}).publishNewChatCatalog());
  await expect(panel.getByRole('button',{name:'Send to New chat',exact:true})).toBeEnabled();
  await expect(field).toHaveText('FIRST_NEW_PRIVATE_MESSAGE');
  await panel.getByRole('button',{name:'Send to New chat',exact:true}).click();
  await expect(panel.getByText('FIRST_NEW_PRIVATE_MESSAGE',{exact:true})).toBeVisible();
  await expect(main.getByRole('textbox')).toHaveText('MAIN_DRAFT_KEEP');
  expect(await page.evaluate(() => (window as unknown as {nativeCreateCalls:unknown[]}).nativeCreateCalls)).toEqual([
    {command:'desktop_chat_new_session',args:{independent:true,sourceSessionId:'private-session'}},
  ]);
  expect(await page.evaluate(() => (window as unknown as {privateSends:{id:string}[]}).privateSends.map(item=>item.id))).toEqual(['new-private-1']);
  expect(await page.evaluate(() => (window as unknown as {unexpectedParentSends:number}).unexpectedParentSends)).toBe(0);
  await panel.getByRole('button',{name:'Side chat options',exact:true}).click();
  await panel.getByRole('button',{name:'Switch Chat',exact:true}).click();
  await panel.getByRole('button',{name:'# Private workspace, Switch side chat',exact:true}).click();
  await expect(panel.getByText('PRIVATE_HISTORY_CANARY',{exact:true})).toBeVisible();
  await expect(panel.getByRole('textbox')).toHaveText('OLD_PRIVATE_DRAFT_KEEP');
});

test('a failed creation retains the old private chat and can be retried', async ({page}) => {
  const panel=page.locator('[data-chat-side-agent-panel="true"]');
  await page.evaluate(()=>{(window as unknown as {failNativeCreate:boolean}).failNativeCreate=true;});
  await panel.getByRole('button',{name:'Side chat options',exact:true}).click();
  await panel.getByRole('button',{name:'New chat',exact:true}).click();
  await expect(panel.getByRole('alert')).toContainText('Could not create a new private chat');
  await expect(panel).toHaveAttribute('data-companion-session-id','private-session');
  await expect(panel.getByText('PRIVATE_HISTORY_CANARY',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Side chat options',exact:true}).click();
  await panel.getByRole('button',{name:'New chat',exact:true}).click();
  await expect(panel).toHaveAttribute('data-companion-session-id','new-private-2');
  await expect(panel.getByRole('textbox')).toHaveText('');
});

test('closing during creation does not reopen the pane when the result arrives', async ({page}) => {
  const panel=page.locator('[data-chat-side-agent-panel="true"]');
  await page.evaluate(()=>{(window as unknown as {holdNativeCreate:boolean}).holdNativeCreate=true;});
  await panel.getByRole('button',{name:'Side chat options',exact:true}).click();
  await panel.getByRole('button',{name:'New chat',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {nativeCreateCalls:unknown[]}).nativeCreateCalls.length)).toBe(1);
  await panel.getByRole('button',{name:'Close side chat',exact:true}).click();
  await page.evaluate(()=>(window as unknown as {finishNativeCreate:()=>void}).finishNativeCreate());
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as {unexpectedParentSends:number}).unexpectedParentSends)).toBe(0);
});

test('successive New chat actions do not reuse the previous empty private session', async ({page}) => {
  const panel=page.locator('[data-chat-side-agent-panel="true"]');
  for (const id of ['new-private-1','new-private-2']) {
    await panel.getByRole('button',{name:'Side chat options',exact:true}).click();
    await panel.getByRole('button',{name:'New chat',exact:true}).click();
    await expect(panel).toHaveAttribute('data-companion-session-id',id);
    await expect(panel.getByRole('textbox')).toHaveText('');
    await expect(panel.getByText('No messages in this side chat yet.',{exact:true})).toBeVisible();
  }
  expect(await page.evaluate(()=>(window as unknown as {nativeCreateCalls:{args:{sourceSessionId:string}}[]}).nativeCreateCalls.map(item=>item.args.sourceSessionId))).toEqual(['private-session','new-private-1']);
});

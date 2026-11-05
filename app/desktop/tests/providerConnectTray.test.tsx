import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import React, { act } from 'react';

import { ProviderConnectTray } from '../src/components/ProviderConnectTray';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const readSource = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('provider tray shows while no provider is connected and Connect opens authentication', async () => {
  let opened = 0;
  await withJsdomRoot(async (mount) => {
    const host = await mount(<ProviderConnectTray needsProvider onConnect={() => { opened += 1; }} />);
    const tray = host.querySelector('[data-provider-connect-tray]');
    assert.ok(tray);
    assert.equal(tray.getAttribute('role'), 'status');
    assert.match(tray.textContent ?? '', /Connect a model to start/);

    const connect = host.querySelector<HTMLButtonElement>('button.app-composer-provider-tray-action');
    assert.ok(connect);
    assert.equal(connect.type, 'button');
    assert.equal(connect.textContent, 'Connect');
    const description = host.ownerDocument.getElementById(connect.getAttribute('aria-describedby') ?? '');
    assert.equal(description?.textContent, 'Connect a model to start');

    await act(async () => { connect.click(); });
    assert.equal(opened, 1);

    await mount(<ProviderConnectTray needsProvider={false} onConnect={() => { opened += 1; }} />);
    assert.equal(host.querySelector('[data-provider-connect-tray]'), null);
  });
});

test('chat and project composers attach the provider tray instead of a top banner', () => {
  const chats = readSource('pages/chatsPage.mainWorkspace.tsx');
  const composer = readSource('pages/chatsPage.mainComposer.tsx');
  const projects = readSource('pages/ProjectsPage.tsx');

  assert.match(chats, /notice: <ProviderConnectTray needsProvider=\{needsProvider\} onConnect=\{openAuthentication\} \/>/);
  assert.match(chats, /auth\.onOpenAccountAuthentication \?\? auth\.onOpenAuthSettings/);
  assert.match(composer, /\{display\.notice\}\n\s*<ComposerDropSurface/);
  assert.match(projects, /<ProviderConnectTray needsProvider=\{!hasAnyAuth\} onConnect=\{openAuthentication\} \/>\n\s*<div className="app-composer-shell/);
  for (const source of [chats, projects]) assert.doesNotMatch(source, /No provider connected yet|AuthNoticeBanner/);
});

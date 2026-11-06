import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { ContactPermissionsHost } from '../src/kordi-app/contacts/contactProfileHost';
import { ContactInfoPopover } from '../src/pages/ContactInfoPopover';
import { installDom } from './helpers/transcriptAttachmentDom';

test('the member popover offers Permissions for someone who is not a contact', async () => {
  const installed = installDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const loaded: string[] = [];
  const saved: Array<[string, unknown]> = [];
  const host: ContactPermissionsHost = {
    load: async (accountId) => { loaded.push(accountId); return { agentAccess: true, cardAccess: false }; },
    save: async (accountId, patch) => { saved.push([accountId, patch]); return { agentAccess: false, cardAccess: false }; },
  };
  try {
    await act(async () => {
      root.render(createElement(ContactInfoPopover, {
        participant: { id: 'human:nadia', humanId: 'acct_nadia', name: 'Nadia Haddad', kind: 'human', role: 'person', source: 'cloud' },
        contacts: [],
        anchorRect: { left: 20, right: 56, top: 120, bottom: 156, width: 36, height: 36 },
        permissionsHost: host,
        onClose: () => undefined,
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(loaded, ['acct_nadia']);
    const section = document.querySelector('[role="group"][aria-label="Permissions"]');
    assert.ok(section, 'the section renders in the popover');
    const switches = [...section.querySelectorAll('[role="switch"]')];
    assert.equal(switches.length, 2);
    assert.equal(switches[0]?.getAttribute('aria-checked'), 'true');
    assert.equal(switches[1]?.getAttribute('aria-checked'), 'false');
    await act(async () => { switches[0]?.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(saved, [['acct_nadia', { agentAccess: false }]]);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('agents in the conversation get no Permissions section', async () => {
  const installed = installDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const host: ContactPermissionsHost = {
    load: async () => ({ agentAccess: true, cardAccess: true }),
    save: async () => ({ agentAccess: true, cardAccess: true }),
  };
  try {
    await act(async () => {
      root.render(createElement(ContactInfoPopover, {
        participant: { id: 'agent:nadia', humanId: 'acct_nadia', name: 'Nadia Kordi', kind: 'agent', role: 'agent', source: 'cloud' },
        contacts: [],
        anchorRect: { left: 20, right: 56, top: 120, bottom: 156, width: 36, height: 36 },
        permissionsHost: host,
        onClose: () => undefined,
      }));
    });
    assert.equal(document.querySelector('[role="group"][aria-label="Permissions"]'), null);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

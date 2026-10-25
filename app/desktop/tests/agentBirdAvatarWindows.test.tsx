import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act } from 'react';

import { setMessageLayout } from '../src/app/messageLayoutPreference';
import { localAgentAvatarFromAccount, setLocalAgentAvatar } from '../src/features/canonical/localAgentAvatar';
import type { CloudAccount } from '../src/features/cloud/authClient';
import { birdAvatarFromSeed } from '../src/features/cloud/birdAvatars';
import { CANONICAL_AVATAR_RENDERER_VERSION, type CanonicalAvatarDescriptor } from '../src/features/cloud/canonicalAvatar';
import { EditableIdentityAvatar } from '../src/kordi-app/components/EditableIdentityAvatar';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';
import { account, agentAvatar, agentReplyRow, ALEX, applyAgentReply, PRIYA } from './helpers/cloudGroupAgentReply';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const RENDERER = CANONICAL_AVATAR_RENDERER_VERSION;
const UPLOADED = 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef';

/** Runs one window's real group pipeline for Priya's agent reply and returns the transcript row it stores. */
async function agentReplyFor(viewer: CloudAccount, priya: CloudAccount, alex: CloudAccount): Promise<Message> {
  return agentReplyRow(await applyAgentReply(viewer, priya, alex), viewer.accountId);
}

/** The src each window's transcript draws for the same agent reply: Priya owns the agent, Alex does not. */
async function bothWindows(priyaAgentAvatar: CanonicalAvatarDescriptor) {
  const priya = account(PRIYA, 'Priya Tester', priyaAgentAvatar);
  const alex = account(ALEX, 'Alex Tester', agentAvatar(ALEX));
  const windows = [
    { name: 'owner' as const, viewer: priya, message: await agentReplyFor(priya, priya, alex) },
    { name: 'collaborator' as const, viewer: alex, message: await agentReplyFor(alex, priya, alex) },
  ];
  const sources: Record<'owner' | 'collaborator', string> = { owner: '', collaborator: '' };
  for (const { name, viewer, message } of windows) {
    await withJsdomRoot(async (mount) => {
      try {
        await act(async () => {
          setMessageLayout('threads');
          setLocalAgentAvatar(localAgentAvatarFromAccount(viewer));
        });
        const host = await mount(<MessageBubble msg={message} />);
        assert.match(host.textContent ?? '', name === 'owner' ? /Owner · You/ : /Owner · Priya Tester/);
        sources[name] = host.querySelector('[data-avatar-kind="agent"] img')?.getAttribute('src') ?? '';
      } finally {
        setMessageLayout('chat');
        setLocalAgentAvatar(null);
      }
    });
  }
  return sources;
}

test('an untouched agent shows the same seeded bird to its owner and to collaborators', async () => {
  const { owner, collaborator } = await bothWindows(agentAvatar(PRIYA));
  assert.match(owner, new RegExp(`/v1/avatars/preview/kordi-birds/default-agent-${PRIYA}\\.png$`));
  assert.equal(collaborator, owner);
});

test('a collaborator sees the bird the owner picked for their agent', async () => {
  const { owner, collaborator } = await bothWindows(agentAvatar(PRIYA, { style: 'kordi-birds', seed: 'bird-owl-ink-sky', version: 2 }));
  assert.match(owner, new RegExp(`/v1/avatars/${RENDERER}/kordi-birds/bird-owl-ink-sky\\.png\\?v=2$`));
  assert.equal(collaborator, owner);
});

test('a collaborator sees the photo the owner uploaded for their agent', async () => {
  const { owner, collaborator } = await bothWindows(agentAvatar(PRIYA, { source: 'uploaded', uploadedAsset: UPLOADED, version: 3 }));
  assert.match(owner, /\/v1\/avatars\/assets\/ava_0123456789abcdef0123456789abcdef\/256\.jpg$/);
  assert.equal(collaborator, owner);
});

test('the avatar picker opens on the bird an untouched agent already shows, and still saves', async () => {
  const seed = `default-agent-${PRIYA}`;
  const shown = birdAvatarFromSeed(seed);
  const picks: string[] = [];
  await withJsdomRoot(async (mount) => {
    try {
      await act(async () => {
        setLocalAgentAvatar(localAgentAvatarFromAccount(account(PRIYA, 'Priya Tester', agentAvatar(PRIYA))));
      });
      const host = await mount(<EditableIdentityAvatar kind="agent" seed={seed} name="Priya Tester's Kordi" onPick={(next) => { picks.push(next); }} />);
      assert.match(host.querySelector('img')?.getAttribute('src') ?? '', new RegExp(`preview/kordi-birds/${seed}\\.png$`));
      await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Choose avatar"]')!.click(); });
      const dialog = document.querySelector('[role="dialog"][aria-label="Avatar"]');
      assert.ok(dialog);
      assert.equal(dialog.querySelector(`[data-bird-species="${shown.species}"]`)?.getAttribute('aria-pressed'), 'true');
      assert.equal(dialog.querySelector(`[data-bird-palette="${shown.palette}"]`)?.getAttribute('aria-checked'), 'true');
      const buttons = () => Array.from(dialog.querySelectorAll('button'));
      assert.equal(buttons().find((button) => button.textContent === 'Color')?.getAttribute('aria-checked'), 'true');
      const save = () => buttons().find((button) => button.textContent === 'Save')!;
      assert.equal(save().disabled, true, 'nothing to save until the bird changes');

      const other = shown.species === 'owl' ? 'heron' : 'owl';
      await act(async () => { dialog.querySelector<HTMLButtonElement>(`[data-bird-species="${other}"]`)!.click(); });
      await act(async () => {
        save().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.deepEqual(picks, [`bird-${other}-color-${shown.palette}`]);
    } finally {
      setLocalAgentAvatar(null);
    }
  });
});

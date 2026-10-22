import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { normalizeContactProfile, type CloudContactProfile } from '../src/features/cloud/contactProfileClient';
import { CommonGroundCard } from '../src/kordi-app/contacts/ContactCommonGround';
import { ContactInfoPopover } from '../src/pages/ContactInfoPopover';
import { installDom } from './helpers/transcriptAttachmentDom';

const OWN = { workingOn: ['tabletop manipulation', 'sim-to-real'], canHelp: ['grant writing'], lookingFor: [] };
const MATCH = {
  score: 82.4,
  headline: 'You both build memory for agents.',
  shared: [
    { topic: 'Agent memory', theirTopic: 'Long-term memory', why: 'Both of you work on it.' },
    { topic: 'Retrieval', theirTopic: 'Retrieval', why: 'Same topic.' },
    { topic: 'Evals' }, { topic: 'Robotics' }, { topic: 'Planning' }, { topic: 'Sixth, dropped' },
  ],
  youBring: [{ topic: 'Grant writing', for: 'Lab funding', why: '…' }],
  theyBring: [{ topic: 'Eval datasets', for: 'Your benchmarks', why: '…' }, { topic: '' }],
  nextStep: 'Compare notes on memory evals.',
  yourProfile: { profileId: 'p_me', kind: 'work', name: 'Work', design: 'work', icon: null },
  theirProfile: { profileId: 'p_them', kind: 'custom', name: 'KAUST', design: 'not-a-design', icon: 'flask' },
  updatedAt: '2026-10-21T08:00:00Z',
};

function profile(commonGround: unknown): CloudContactProfile {
  return normalizeContactProfile({ accountId: 'acct_nadia', kind: 'person', commonGround })!;
}

test('the match is read defensively and a missing match is null', () => {
  const ground = profile({ ...OWN, match: MATCH }).commonGround!;
  const match = ground.match!;
  assert.equal(match.score, 82);
  assert.equal(match.shared.length, 5, 'at most five shared topics');
  assert.equal(match.shared[0].theirTopic, 'Long-term memory');
  assert.equal(match.shared[1].theirTopic, null, 'the same topic is not repeated');
  assert.deepEqual(match.theyBring.map((item) => item.topic), ['Eval datasets']);
  assert.equal(match.theirProfile?.design, 'research', 'an unknown design falls back to the name');
  assert.equal(match.theirProfile?.icon, 'flask');

  assert.equal(profile(OWN).commonGround?.match, null, 'older servers send no match');
  assert.equal(profile({ ...OWN, match: null }).commonGround?.match, null);
  assert.equal(profile({ ...OWN, match: { score: 'high' } }).commonGround?.match, null);
  assert.equal(profile({ workingOn: [], match: null }).commonGround, null);
  assert.ok(profile({ match: MATCH }).commonGround?.match, 'a match alone keeps the section');
});

test('with a match the card shows the score, shared chips, trades and their card', () => {
  const markup = renderToStaticMarkup(createElement(CommonGroundCard, { card: profile({ ...OWN, match: MATCH }).commonGround! }));
  assert.match(markup, />Common ground</);
  assert.match(markup, />82<\/span><span[^>]*>% match</);
  assert.match(markup, /data-design="research"/);
  assert.match(markup, />KAUST</);
  assert.match(markup, />You both</);
  assert.match(markup, /title="Agent memory · Long-term memory">Agent memory</);
  assert.match(markup, /title="Retrieval">Retrieval</);
  assert.match(markup, />They can help with<.*>Eval datasets</);
  assert.match(markup, />You can help with<.*>Grant writing</);
  assert.match(markup, />Compare notes on memory evals\.</);
  assert.match(markup, /aria-expanded="false"[^>]*>.*Their card/);
  assert.doesNotMatch(markup, /Working on/, 'their own topics stay folded');
  assert.doesNotMatch(markup, /COMMON|YOU BOTH/);
});

test('without a match the card renders their topics as before', () => {
  const markup = renderToStaticMarkup(createElement(CommonGroundCard, { card: profile(OWN).commonGround! }));
  assert.match(markup, />Common ground</);
  assert.match(markup, />Working on<.*>tabletop manipulation<.*>sim-to-real</);
  assert.match(markup, />Can help<.*>grant writing</);
  assert.doesNotMatch(markup, /% match|You both|Their card|Looking for/);
});

test('the chat person popover shows the compact section above the shared rows', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const loaded: string[] = [];
  try {
    await act(async () => {
      root.render(createElement(ContactInfoPopover, {
        participant: { id: 'human:nadia', humanId: 'acct_nadia', name: 'Nadia Haddad', kind: 'human', role: 'person', source: 'cloud' },
        contacts: [],
        anchorRect: { left: 20, right: 56, top: 120, bottom: 156, width: 36, height: 36 },
        loadProfile: async (accountId: string) => {
          loaded.push(accountId);
          return profile({ ...OWN, match: MATCH });
        },
        onClose: () => undefined,
      }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(loaded, ['acct_nadia']);
    const dialog = document.querySelector('[role="dialog"]');
    const section = dialog?.querySelector('[role="group"][aria-label="Common ground"]');
    assert.ok(section, 'the section renders in the popover');
    assert.match(section.textContent ?? '', /^82% matchKAUSTYou both/);
    const text = dialog?.textContent ?? '';
    assert.ok(text.indexOf('% match') < text.indexOf('Nothing shared yet'), 'common ground sits above the shared rows');

    const disclosure = [...section.querySelectorAll('button')].find((button) => button.textContent === 'Their card');
    await act(async () => { disclosure?.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true })); });
    assert.match(section.textContent ?? '', /Working ontabletop manipulation/);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

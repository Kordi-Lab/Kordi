import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Conversation, Message } from '../src/kordi-app/types';
import {
  collectContactProfileSharedItems,
  groupSharedItemsByMonth,
  sharedConversationIsComplete,
  sharedItemDateLabel,
  sharedLinkDisplayUrl,
} from '../src/pages/contactProfileSharedItems';
import { contactProfileSharedSummary } from '../src/pages/memberContactProfileModel';

const now = new Date(2026, 9, 21, 12);
const at = (month: number, day: number, year = 2026) => new Date(year, month, day, 10).getTime();

const messages: Message[] = [
  {
    id: 'm1', role: 'person', time: '', timestampMs: at(7, 30, 2025),
    text: 'Old notes https://www.example.org/old',
    attachments: [{ kind: 'image', name: 'old.png' }],
  },
  {
    id: 'm2', role: 'person', time: '', timestampMs: at(8, 9),
    text: 'See [Grant checklist](https://docs.example.com/grant) and https://arxiv.org/abs/1.',
    attachments: [
      { kind: 'image', name: 'bench.jpg' },
      { kind: 'file', name: 'walkthrough.mp4', mimeType: 'video/mp4' },
      { kind: 'file', name: 'demo.mov', mimeType: 'video/quicktime' },
    ],
  },
  {
    id: 'm3', role: 'user', time: '', timestampMs: at(9, 14),
    text: 'Again https://arxiv.org/abs/1',
    attachments: [
      { kind: 'file', name: 'Grant draft v3.pdf', mimeType: 'application/pdf', sizeBytes: 1_258_291 },
      { kind: 'image', name: 'sticker.webp', subtype: 'sticker' },
      { kind: 'image', name: 'archive.zip' },
    ],
  },
  { id: 'm4', role: 'person', time: '', timestampMs: at(9, 18), text: 'No attachments here.' },
];

test('images and playable videos are photos; other attachments are files; stickers are left out', () => {
  const items = collectContactProfileSharedItems(messages);
  assert.deepEqual(items.photos.map((photo) => [photo.attachment.name, photo.isVideo]), [
    ['walkthrough.mp4', true],
    ['bench.jpg', false],
    ['old.png', false],
  ]);
  assert.deepEqual(items.files.map((file) => file.attachment.name), ['archive.zip', 'Grant draft v3.pdf', 'demo.mov']);
  assert.equal(items.files[1].timestampMs, at(9, 14), 'items take the message time');
});

test('links are distinct, newest first, with markdown labels and bare domains', () => {
  const { links } = collectContactProfileSharedItems(messages);
  assert.deepEqual(links.map((link) => [link.href, link.label, link.domain]), [
    ['https://arxiv.org/abs/1', null, 'arxiv.org'],
    ['https://docs.example.com/grant', 'Grant checklist', 'docs.example.com'],
    ['https://www.example.org/old', null, 'example.org'],
  ]);
  assert.equal(links[0].timestampMs, at(9, 14), 'a repeated link keeps its latest message');
});

test('items group by month, with the year outside the current one', () => {
  const { photos, files } = collectContactProfileSharedItems(messages);
  assert.deepEqual(groupSharedItemsByMonth(photos, now).map((group) => [group.label, group.items.length]), [
    ['September', 2],
    ['August 2025', 1],
  ]);
  assert.deepEqual(groupSharedItemsByMonth(files, now).map((group) => group.label), ['October', 'September']);
  assert.equal(sharedItemDateLabel(at(9, 14), now), '14 Oct');
  assert.equal(sharedItemDateLabel(at(7, 30, 2025), now), '30 Aug 2025');
  assert.equal(sharedItemDateLabel(at(8, 22), now), '22 Sep');
  assert.equal(sharedLinkDisplayUrl('https://www.nature.com/articles/x'), 'nature.com/articles/x');
  const undated = groupSharedItemsByMonth([{ key: 'a', timestampMs: null }, { key: 'b', timestampMs: at(9, 2) }], now);
  assert.deepEqual(undated.map((group) => group.label), ['October', ''], 'undated items come last without a label');
});

test('row counts equal the page lengths', () => {
  const conversation = { messages } as Conversation;
  const items = collectContactProfileSharedItems(messages);
  assert.deepEqual(contactProfileSharedSummary(conversation, 1), {
    photos: items.photos.length,
    files: items.files.length,
    links: items.links.length,
    commonGroups: 1,
  });
  assert.deepEqual(contactProfileSharedSummary(null), { photos: 0, files: 0, links: 0, commonGroups: 0 });
});

test('only a fully held conversation backs the pane pages', () => {
  assert.equal(sharedConversationIsComplete(null), false);
  assert.equal(sharedConversationIsComplete({ messages: [] } as unknown as Conversation), false);
  assert.equal(sharedConversationIsComplete({ messages } as Conversation), true);
  assert.equal(sharedConversationIsComplete({ messages, canonicalMessageCount: 4 } as Conversation), true);
  assert.equal(sharedConversationIsComplete({ messages, canonicalMessageCount: 40 } as Conversation), false);
});

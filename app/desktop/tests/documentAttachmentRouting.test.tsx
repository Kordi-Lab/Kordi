import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, type ReactElement } from 'react';

import { canonicalAttachments } from '../src/features/canonical/readModel/attachmentMapping';
import { COMPANION_DOCUMENT_OPEN_EVENT, openAttachmentInCompanion, type CompanionDocument } from '../src/features/documents/companionDocument';
import { useCompanionDocumentRequests } from '../src/features/documents/useCompanionDocument';
import { AttachmentActions } from '../src/kordi-app/components/transcriptAttachmentActions';
import { AttachmentPreview } from '../src/kordi-app/components/transcriptAttachments';
import type { Message, MessageAttachment } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const OWNER = 'acct_example_owner';
const MEMBER = 'acct_example_member';

/** A cloud group message's content exactly as the canonical store keeps it (attachment from another member). */
function storedContent(name: string, attachmentId: string, localPath: string | null) {
  return {
    attachments: [{ attachmentId, downloadUrl: null, kind: 'file', localPath, mimeType: name.endsWith('.html') ? 'text/html' : 'text/markdown', name, previewUrl: null, sizeBytes: 438 }],
    cloudMessageVersion: 1,
    conversationSequence: 2,
    editedAt: null,
  };
}

function groupMessage(sender: string, viewer: string, attachments: MessageAttachment[]): Message {
  return {
    id: 'msg:ui:example',
    role: sender === viewer ? 'user' : 'person',
    sender: sender === OWNER ? 'Alex Morgan' : 'Priya',
    senderIdentityId: `human:${sender}`,
    senderType: 'human',
    text: '',
    time: '12:23',
    attachments,
  } as Message;
}

/** The native shell bridge, recording every desktop command (open, download, save). */
function installDesktopBridge() {
  const commands: string[] = [];
  const target = window as unknown as Record<string, unknown>;
  target.__TAURI_INTERNALS__ = {
    invoke: (command: string) => { commands.push(command); return Promise.resolve('/Users/example/Downloads/copy'); },
    transformCallback: () => 0,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
  return commands;
}

function ChatPageListener({ onRequest }: { onRequest: (document: CompanionDocument) => void }) {
  useCompanionDocumentRequests(onRequest);
  return null;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function mountWithListener(mount: (element: ReactElement) => Promise<HTMLElement>, element: ReactElement) {
  const opened: CompanionDocument[] = [];
  const root = await mount(createElement('div', null, createElement(ChatPageListener, { onRequest: (document) => opened.push(document) }), element));
  return { root, opened };
}

for (const [label, sender, viewer] of [['the viewer sent it', OWNER, OWNER], ['another member sent it', MEMBER, OWNER]] as const) {
  for (const localPath of [null, '/Users/example/Library/Caches/design-review.md']) {
    for (const name of ['design-review.md', 'prototype.html']) {
      test(`a ${name} chip opens the reader (${label}, ${localPath ? 'downloaded before' : 'not downloaded'}) and never opens or downloads the file`, async () => {
        await withJsdomRoot(async (mount) => {
          const commands = installDesktopBridge();
          const attachments = canonicalAttachments(storedContent(name, 'att_example_review', localPath).attachments);
          assert.ok(attachments?.[0]?.attachmentId, 'the read model keeps the cloud id');
          const { root, opened } = await mountWithListener(mount, createElement(AttachmentPreview, { msg: groupMessage(sender, viewer, attachments) }));
          const chip = root.querySelector<HTMLButtonElement>('[data-attachment-file-chip="true"]');
          assert.ok(chip, 'the file chip renders');
          await act(async () => { chip.click(); });
          await settle();
          assert.equal(opened.length, 1, 'the companion open request was handled');
          assert.equal(opened[0].artifact.attachmentId, 'att_example_review');
          assert.equal(opened[0].artifact.name, name);
          assert.deepEqual(commands, [], 'no desktop open or download command');
        });
      });
    }
  }
}

test('a PDF chip keeps its own action: no reader request, the file opens', async () => {
  await withJsdomRoot(async (mount) => {
    const commands = installDesktopBridge();
    const attachments = canonicalAttachments([{ attachmentId: 'att_example_pdf', kind: 'file', name: 'paper.pdf', mimeType: 'application/pdf', localPath: '/Users/example/paper.pdf' }]);
    const { root, opened } = await mountWithListener(mount, createElement(AttachmentPreview, { msg: groupMessage(MEMBER, OWNER, attachments ?? []) }));
    await act(async () => { root.querySelector<HTMLButtonElement>('[data-attachment-file-chip="true"]')!.click(); });
    await settle();
    assert.equal(opened.length, 0);
    assert.deepEqual(commands, ['desktop_open_external_url']);
  });
});

test('the chip menu Open routes a document to the reader; Save As stays a file action', async () => {
  await withJsdomRoot(async (mount) => {
    const commands = installDesktopBridge();
    const attachments = canonicalAttachments(storedContent('design-review.md', 'att_example_review', null).attachments) ?? [];
    const { root, opened } = await mountWithListener(mount, createElement(AttachmentPreview, { msg: groupMessage(MEMBER, OWNER, attachments) }));
    const chip = root.querySelector<HTMLButtonElement>('[data-attachment-file-chip="true"]')!;
    await act(async () => { chip.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
    const menu = document.querySelector('[data-attachment-file-menu="true"]');
    assert.ok(menu, 'the file menu opens');
    const open = [...menu.querySelectorAll('button')].find((button) => button.textContent === 'Open');
    assert.ok(open, 'the menu offers Open');
    assert.ok([...menu.querySelectorAll('button')].some((button) => button.textContent === 'Save As…'));
    await act(async () => { open.click(); });
    await settle();
    assert.equal(opened.length, 1);
    assert.deepEqual(commands, []);
  });
});

for (const [variant, label] of [['menu', 'Download design-review.md'], ['icon', 'Download design-review.md']] as const) {
  test(`attachment actions (${variant}) send a document to the reader instead of downloading it`, async () => {
    await withJsdomRoot(async (mount) => {
      const commands = installDesktopBridge();
      const attachment = canonicalAttachments(storedContent('design-review.md', 'att_example_review', '/Users/example/design-review.md').attachments)![0];
      const { root, opened } = await mountWithListener(mount, createElement(AttachmentActions, { attachment, variant }));
      const download = root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
      assert.ok(download);
      await act(async () => { download.click(); });
      const openLocal = root.querySelector<HTMLButtonElement>('[aria-label="Open design-review.md with local app"]');
      assert.ok(openLocal);
      await act(async () => { openLocal.click(); });
      await settle();
      assert.equal(opened.length, 2);
      assert.deepEqual(commands, []);
    });
  });
}

test('attachment actions (open original) send a document to the reader', async () => {
  await withJsdomRoot(async (mount) => {
    const commands = installDesktopBridge();
    const attachment = canonicalAttachments(storedContent('prototype.html', 'att_example_html', null).attachments)![0];
    const { root, opened } = await mountWithListener(mount, createElement(AttachmentActions, { attachment, variant: 'original' }));
    await act(async () => { root.querySelector<HTMLButtonElement>('[data-attachment-original-action="true"]')!.click(); });
    await settle();
    assert.equal(opened.length, 1);
    assert.deepEqual(commands, []);
  });
});

test('a request made while no chat page listens waits for the next one instead of downloading', async () => {
  await withJsdomRoot(async (mount) => {
    const seen: string[] = [];
    const record = (event: Event) => seen.push((event as CustomEvent<CompanionDocument>).detail.artifact.name);
    window.addEventListener(COMPANION_DOCUMENT_OPEN_EVENT, record);
    const attachment = canonicalAttachments(storedContent('design-review.md', 'att_example_review', null).attachments)![0];
    assert.equal(openAttachmentInCompanion(attachment), true, 'the caller never falls back to a download');
    window.removeEventListener(COMPANION_DOCUMENT_OPEN_EVENT, record);
    assert.deepEqual(seen, ['design-review.md']);
    const opened: CompanionDocument[] = [];
    await mount(createElement(ChatPageListener, { onRequest: (document) => opened.push(document) }));
    assert.equal(opened.length, 1, 'the next chat page opens it');
    assert.equal(opened[0].artifact.attachmentId, 'att_example_review');
  });
});

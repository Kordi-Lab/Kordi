import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message, MessageAttachment } from '../src/kordi-app/types';
import { installDom, flushReactUpdates } from './helpers/transcriptAttachmentDom';

for (const own of [true, false]) {
  test(`mixed ${own ? 'own' : 'peer'} message expands and previews sibling images while retaining files`, async () => {
    const environment = installDom();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let openedUrl = '';
    window.open = ((url: string | URL) => {
      openedUrl = String(url);
      return { focus() {} } as Window;
    }) as typeof window.open;
    const images: MessageAttachment[] = [0, 1].map(index => ({
      kind: 'image', name: `image-${index}.png`, attachmentId: `image-${index}`,
      previewUrl: `https://files.test/${index}.png`, mimeType: 'image/png',
    }));
    const message: Message = {
      id: 'mixed', role: own ? 'user' : 'person', senderType: 'human', isOwnMessage: own,
      sender: 'Synthetic sender', text: 'Synthetic caption.', time: '12:30', statusChips: ['delivered'],
      attachments: [images[0], {kind:'file',name:'notes.txt',mimeType:'text/plain',attachmentId:'notes'}, images[1]],
    };
    try {
      await act(async () => root.render(createElement(MessageBubble, {msg:message})));
      const caption = host.querySelector('[data-message-caption-bubble]');
      const file = caption?.querySelector('[data-attachment-file-chip]');
      assert.ok(file);
      assert.match(file.textContent ?? '', /notes\.txt/);
      const expand = host.querySelector<HTMLButtonElement>('[data-attachment-image-group-disclosure]');
      assert.ok(expand);
      await act(async () => expand.click());
      assert.equal(expand.getAttribute('aria-expanded'), 'true');
      const triggers = host.querySelectorAll<HTMLButtonElement>('[data-attachment-image-preview-trigger]');
      assert.equal(triggers.length, 2);
      await act(async () => triggers[1].click());
      await flushReactUpdates();
      const requestId = new URL(openedUrl).searchParams.get('mediaPreviewRequest');
      assert.ok(requestId);
      const payload = JSON.parse(window.localStorage.getItem(`kordi:attachment-media:${requestId}`) ?? '');
      assert.equal(payload.selectedIndex, 1);
      assert.deepEqual(payload.attachments.map((a: MessageAttachment) => a.attachmentId), ['image-0', 'image-1']);
      assert.equal(caption?.querySelector('[data-attachment-file-chip]'), file);
      assert.ok(caption?.textContent?.includes('Synthetic caption.'));
      assert.equal(caption?.querySelectorAll('[data-attachment-image-card]').length, 0);
      await act(async () => expand.click());
      assert.equal(expand.getAttribute('aria-expanded'), 'false');
    } finally {
      await act(async () => root.unmount());
      environment.restore();
    }
  });
}

for (const role of ['user', 'person', 'assistant'] as const) {
  for (const mixed of [false, true]) {
    test(`${role} image group keeps its sender avatar beside the images despite adjacent same-sender messages, mixed=${mixed}`, async () => {
      const environment = installDom();
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const message: Message = {
        id: 'group-avatar', role, sender: 'Synthetic sender',
        senderType: role === 'assistant' ? 'agent' : 'human', isOwnMessage: role === 'user',
        senderProfileImageUrl: 'https://files.test/sender.png', text: mixed ? 'Synthetic caption.' : '', time: '12:30',
        attachments: [
          { kind: 'image', name: 'first.png', previewUrl: 'https://files.test/first.png', mimeType: 'image/png' },
          { kind: 'image', name: 'second.png', previewUrl: 'https://files.test/second.png', mimeType: 'image/png' },
          ...(mixed ? [{ kind: 'file' as const, name: 'notes.txt', mimeType: 'text/plain', attachmentId: 'notes' }] : []),
        ],
      };
      let openedSender: Message | undefined;
      try {
        await act(async () => root.render(createElement(MessageBubble, {
          msg: message, isGroupedWithPrevious: true, isGroupedWithNext: true,
          onOpenSenderProfile: (sender: Message) => { openedSender = sender; },
        })));
        const surface = host.querySelector('[data-message-context-menu-anchor]');
        let row = surface?.parentElement;
        while (row && !row.querySelector('[data-avatar-kind]')) row = row.parentElement;
        const avatar = row?.querySelector('[data-avatar-kind]');
        assert.ok(avatar, 'every image group must identify its sender');
        assert.equal(avatar.getAttribute('data-avatar-kind'), role === 'assistant' ? 'agent' : 'human');
        assert.ok(row?.classList.contains('items-start'), 'avatar stays level with the first image, not the caption bottom');
        assert.ok(!surface?.contains(avatar), 'avatar belongs beside the group');
        const expand = host.querySelector<HTMLButtonElement>('[data-attachment-image-group-disclosure]');
        assert.ok(expand);
        await act(async () => expand.click());
        assert.equal(row?.querySelector('[data-avatar-kind]'), avatar, 'expansion preserves sender identity');
        if (role === 'person') {
          const profile = row?.querySelector<HTMLButtonElement>('[data-message-sender-profile]');
          assert.ok(profile);
          await act(async () => profile.click());
          assert.equal(openedSender, message);
        }
      } finally {
        await act(async () => root.unmount());
        environment.restore();
      }
    });
  }
}

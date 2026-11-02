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

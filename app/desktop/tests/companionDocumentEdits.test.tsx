import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act, useState } from 'react';
import type { Editor } from '@tiptap/core';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import { ChatCompanionLayout } from '../src/pages/chatsPage.companionLayout';
import { useChatCompanionLayout } from '../src/pages/useChatCompanionLayout';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

for (const action of ['fold', 'switch to Chat'] as const) {
  test(`local edits and upload survive repeated ${action} and return`, async () => {
    await withJsdomRoot(async mount => {
      const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
      Object.assign(window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: empty });
      const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'));
      const current: { editor: Editor | null } = { editor: null };
      let layout!: ReturnType<typeof useChatCompanionLayout>;
      let select!: (view: 'chat' | 'document') => void;
      let open!: (id: string | null) => void;
      function Harness() {
        const [view, setView] = useState<'chat' | 'document'>('document');
        const [id, setId] = useState<string | null>('first');
        select = setView;
        open = setId;
        layout = useChatCompanionLayout({ pageConversationId: 'review', activePaneKind: 'human', companionConversation: null, hasOverview: true });
        return <ChatCompanionLayout containerRef={null} layout={layout} view={view} openedViews={[]}
          companionPane={<p>Chat</p>}
          documentPane={id ? <DocumentReader key={id} path={`${action}/${id}.md`} localSource={`# ${id}\n\nOriginal paragraph.`} api={api}
            onEditor={editor => { current.editor = editor; }} /> : null}>
          <p>Main conversation</p>
        </ChatCompanionLayout>;
      }
      const root = await mount(<Harness />);
      await waitForReactCondition(() => Boolean(current.editor && root.querySelector('.ProseMirror > h1')), 'editor loaded');
      const original = current.editor!;
      for (const text of ['First edit. ', 'Second edit. ']) {
        await act(() => { current.editor!.commands.setTextSelection(1); current.editor!.commands.insertContent(text); });
        await act(() => { if (action === 'fold') layout.setFolded(true); else select('chat'); });
        if (action === 'fold') await waitForReactCondition(() => !layout.isPresent, 'fold animation completed');
        // Tiptap destroys an effect-disconnected editor on a timer, not during React's commit.
        await settle();
        await act(() => { if (action === 'fold') layout.setFolded(false); else select('document'); });
        await waitForReactCondition(() => Boolean(current.editor && !current.editor.isDestroyed), 'editor visible');
        assert.match(current.editor!.getText(), /First edit\./, 'the draft survives reopening');
        assert.equal(current.editor, original, 'selection, undo history, and editor session survive too');
      }
      assert.match(current.editor!.getText(), /Second edit\./);
      await act(() => { current.editor!.commands.undo(); });
      assert.doesNotMatch(current.editor!.getText(), /Second edit\./);
      await act(() => { current.editor!.commands.redo(); });
      assert.match(current.editor!.getText(), /Second edit\./);

      const button = (text: string) => {
        const found = Array.from(root.querySelectorAll('button')).find(entry => entry.textContent?.trim() === text);
        assert.ok(found, `${text} is available`);
        return found;
      };
      await act(() => button('Share').click());
      await act(() => button('Upload to Kordi').click());
      await waitForReactCondition(() => calls.some(call => call.method === 'saveDocumentContent'), 'upload saved');
      const saved = calls.find(call => call.method === 'saveDocumentContent')!.args[1] as { source: string };
      assert.match(saved.source, /First edit\./);
      assert.match(saved.source, /Second edit\./);

      await act(() => open('second'));
      await waitForReactCondition(() => Boolean(current.editor?.getText().startsWith('second')), 'another document loaded');
      assert.doesNotMatch(current.editor!.getText(), /First edit|Second edit/, 'drafts stay within their document');
      await settle();
      assert.equal(original.isDestroyed, true, 'replacing the document releases its editor');
      const second = current.editor!;
      await act(() => open(null));
      await settle();
      assert.equal(second.isDestroyed, true, 'explicitly closing a document releases its editor');
    });
  });
}

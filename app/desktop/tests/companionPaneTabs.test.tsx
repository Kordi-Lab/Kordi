import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, useState } from 'react';
import { useCompanionDocument } from '../src/features/documents/useCompanionDocument';
import { useCompanionPaneTabs } from '../src/pages/useCompanionPaneTabs';
import { withJsdomRoot } from './helpers/mountWithJsdom';

test('tool tabs deduplicate, coexist with documents, and close without disturbing another active tab', async () => {
  await withJsdomRoot(async mount => {
    let tabs!: ReturnType<typeof useCompanionPaneTabs>;
    let documents!: ReturnType<typeof useCompanionDocument>;
    let navigate!: (id: string) => void;
    function Harness() {
      const [id, setId] = useState('first');
      navigate = setId;
      documents = useCompanionDocument(id);
      tabs = useCompanionPaneTabs(id, documents, { name: 'Design discussion' });
      return null;
    }
    await mount(createElement(Harness));
    await act(() => { tabs.setView('digest'); tabs.setView('calendar'); tabs.setView('calendar'); });
    assert.deepEqual(tabs.opened, ['chat', 'digest', 'calendar']);
    await act(() => {
      documents.open({ artifact: { id: 'notes', name: 'notes.txt', path: 'notes.txt', kind: 'file', summary: '' }, sourceView: true });
      tabs.setView('document');
    });
    await act(() => tabs.activate('view:digest'));
    await act(() => { assert.equal(tabs.close('notes'), false); });
    assert.equal(tabs.view, 'digest', 'Closing an inactive document keeps the active tool selected');
    await act(() => { assert.equal(tabs.close('view:digest'), false); });
    assert.equal(tabs.view, 'calendar', 'Closing the active tool chooses its neighbor');
    await act(() => tabs.close('view:calendar'));
    await act(() => { assert.equal(tabs.close('view:chat'), true); });
    assert.equal(tabs.hasTabs, false);
    await act(() => tabs.setView('chat'));
    assert.equal(tabs.items.length, 1);
    await act(() => navigate('second'));
    assert.deepEqual(tabs.opened, ['chat']);
    assert.equal(documents.documents.length, 0);
  });
});

test('closing the last document selects an open tool and only an entirely empty strip folds', async () => {
  await withJsdomRoot(async mount => {
    let tabs!: ReturnType<typeof useCompanionPaneTabs>;
    let documents!: ReturnType<typeof useCompanionDocument>;
    function Harness() {
      documents = useCompanionDocument('conversation');
      tabs = useCompanionPaneTabs('conversation', documents, null);
      return null;
    }
    await mount(createElement(Harness));
    await act(() => tabs.setView('calendar'));
    await act(() => {
      documents.open({ artifact: { id: 'notes', name: 'notes.txt', path: 'notes.txt', kind: 'file', summary: '' }, sourceView: true });
      tabs.setView('document');
    });
    await act(() => { assert.equal(tabs.close('notes'), false); });
    assert.equal(tabs.view, 'calendar');
    await act(() => { assert.equal(tabs.close('view:calendar'), true); });
    assert.equal(tabs.hasTabs, false);
  });
});

test('the chat tab follows session titles without changing selection or adding another tab', async () => {
  await withJsdomRoot(async mount => {
    let tabs!: ReturnType<typeof useCompanionPaneTabs>;
    let setChat!: (chat: { name: string }) => void;
    function Harness() {
      const [chat, updateChat] = useState({ name: 'First session' });
      setChat = updateChat;
      const documents = useCompanionDocument('conversation');
      tabs = useCompanionPaneTabs('conversation', documents, chat);
      return null;
    }
    await mount(createElement(Harness));
    const id = tabs.items[0].id;
    assert.equal(tabs.items[0].title, 'First session');
    await act(() => setChat({ name: 'Renamed session' }));
    assert.equal(tabs.items[0].title, 'Renamed session');
    assert.equal(tabs.activeId, id);
    await act(() => tabs.setView('calendar'));
    await act(() => setChat({ name: 'Another private conversation' }));
    assert.equal(tabs.items[0].title, 'Another private conversation');
    assert.equal(tabs.items[0].id, id);
    assert.equal(tabs.items.length, 2);
    assert.equal(tabs.view, 'calendar');
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
let VirtualTranscript: typeof import('../src/features/chat/VirtualTranscript').VirtualTranscript;
import { cleanupVirtualTranscriptHarness, flush, installVirtualTranscriptHarness, render, rows, triggerObservedResize } from './support/virtualTranscriptHarness';

test.before(async () => {
  await installVirtualTranscriptHarness();
  ({ VirtualTranscript } = await import('../src/features/chat/VirtualTranscript'));
});
test.afterEach(cleanupVirtualTranscriptHarness);

test('geometry updates preserve row content while changed messages and renderers still update', async () => {
  const calls: string[] = [];
  const initial = rows('render-', 0, 30);
  const renderItem = (item: typeof initial[number]) => {
    calls.push(item.id);
    return <div data-test-row-height={item.height}>{item.id}</div>;
  };
  const viewFor = (items: typeof initial, renderer = renderItem) => <VirtualTranscript
    sessionKey="scope" items={items} getItemKey={item => item.id} renderItem={renderer} scrollStyle={{ height: 600 }} />;
  const view = await render(viewFor(initial));
  calls.length = 0;
  const lastRow = view.host.querySelector<HTMLElement>('[data-index="29"]')!;
  assert.ok(lastRow);
  await act(async () => {
    lastRow.dataset.testRowHeight = '80';
    triggerObservedResize?.(lastRow);
  });
  await flush();
  assert.deepEqual(calls, [], 'A measurement change must not rebuild existing row content');
  const changed = initial.map((item, index) => index === 29 ? { ...item, height: 80 } : item);
  await view.rerender(viewFor(changed));
  assert.deepEqual(calls, ['render-29']);
  await view.rerender(viewFor(changed, item => <div data-test-row-height={item.height}>Updated {item.id}</div>));
  assert.match(view.host.textContent ?? '', /Updated render-29/);
});

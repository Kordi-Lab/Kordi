import assert from 'node:assert/strict';
import test from 'node:test';

import { copyTextWhenReady } from '../src/features/chat/copyTextWhenReady';

function withGlobals(values: Record<string, unknown>, run: () => Promise<void>) {
  const saved = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.entries(values).forEach(([key, value]) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }));
  return run().finally(() => saved.forEach(([key, descriptor]) => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }));
}

class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

test('the write starts during the click and waits for text that is still on its way', async () => {
  const writes: FakeClipboardItem[][] = [];
  await withGlobals({
    ClipboardItem: FakeClipboardItem,
    navigator: { clipboard: { write: async (items: FakeClipboardItem[]) => { writes.push(items); await items[0].items['text/plain']; }, writeText: async () => { throw new Error('unused'); } } },
  }, async () => {
    let resolve!: (value: string) => void;
    const copied = copyTextWhenReady(new Promise<string>((done) => { resolve = done; }));
    assert.equal(writes.length, 1, 'the clipboard write starts before the text arrives');
    resolve('https://kordi.example/g/kordi_gi_1');
    await copied;
    assert.equal(await (await writes[0][0].items['text/plain']).text(), 'https://kordi.example/g/kordi_gi_1');
  });
});

test('without a pending clipboard item the text is written once it arrives', async () => {
  const written: string[] = [];
  await withGlobals({
    ClipboardItem: undefined,
    navigator: { clipboard: { writeText: async (text: string) => { written.push(text); } } },
  }, async () => {
    await copyTextWhenReady(Promise.resolve('https://kordi.example/g/kordi_gi_2'));
    assert.deepEqual(written, ['https://kordi.example/g/kordi_gi_2']);
  });
});

test('text that never arrives, or no clipboard, rejects without writing', async () => {
  const written: string[] = [];
  await withGlobals({
    ClipboardItem: undefined,
    navigator: { clipboard: { writeText: async (text: string) => { written.push(text); } } },
  }, async () => {
    await assert.rejects(copyTextWhenReady(Promise.reject(new Error('The group was not created.'))));
    assert.deepEqual(written, []);
  });
  await withGlobals({ navigator: {} }, async () => {
    await assert.rejects(copyTextWhenReady(Promise.resolve('https://kordi.example/g/kordi_gi_3')));
  });
});

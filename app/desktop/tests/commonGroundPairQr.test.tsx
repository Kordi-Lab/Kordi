import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import { PairQr } from '../src/features/commonGround/PairQr';
import { installDom } from './helpers/transcriptAttachmentDom';

test('Pair QR renders again after closing and reopening with its encoder cached', async () => {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(PairQr, { value: 'https://example.test/pair/ABCD-1234' })));
    for (let attempt = 0; attempt < 100 && !host.querySelector('svg path'); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    assert.ok(host.querySelector('svg path')?.getAttribute('d'));
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(PairQr, { value: 'https://example.test/pair/EFGH-5678' })));
    assert.ok(host.querySelector('svg path')?.getAttribute('d'), 'reopening must retain a working encoder');
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

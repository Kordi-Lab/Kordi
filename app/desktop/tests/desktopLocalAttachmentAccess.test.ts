import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DESKTOP_ATTACHMENT_ACCESS_DENIED_MESSAGE,
  isDesktopAttachmentAccessDenied,
  withDesktopAttachmentPathFallback,
} from '../src/lib/desktopLocalAttachments';

test('the access-denied message matches the native attachment policy', () => {
  const nativeSource = readFileSync(
    new URL('../src-tauri/src/chat/attachments/access.rs', import.meta.url),
    'utf8',
  );
  assert.ok(
    nativeSource.includes(`"${DESKTOP_ATTACHMENT_ACCESS_DENIED_MESSAGE}"`),
    'desktop and native copies of the access-denied message must stay identical',
  );
  assert.equal(isDesktopAttachmentAccessDenied(new Error(DESKTOP_ATTACHMENT_ACCESS_DENIED_MESSAGE)), true);
  assert.equal(isDesktopAttachmentAccessDenied(new Error('Attachment is not a file: /tmp')), false);
  assert.equal(isDesktopAttachmentAccessDenied(DESKTOP_ATTACHMENT_ACCESS_DENIED_MESSAGE), false);
});

test('an unavailable local path retries once on the Cloud copy', async () => {
  const calls: string[] = [];
  const result = await withDesktopAttachmentPathFallback(
    '/Users/example/Documents/report.pdf',
    async () => '/app/tmp/attachments/cloud/report.pdf',
    async (path) => {
      calls.push(path);
      if (path.startsWith('/Users/')) throw new Error(DESKTOP_ATTACHMENT_ACCESS_DENIED_MESSAGE);
      return `opened ${path}`;
    },
  );

  assert.equal(result, 'opened /app/tmp/attachments/cloud/report.pdf');
  assert.deepEqual(calls, [
    '/Users/example/Documents/report.pdf',
    '/app/tmp/attachments/cloud/report.pdf',
  ]);
});

test('other failures and missing Cloud copies keep the original error', async () => {
  const runnable = new Error('This file can run code, so Kordi will not open it directly.');
  let resolved = 0;
  await assert.rejects(
    withDesktopAttachmentPathFallback('/app/tmp/attachments/run.command', async () => {
      resolved += 1;
      return '/other';
    }, async () => { throw runnable; }),
    runnable,
  );
  assert.equal(resolved, 0, 'only the access-denied error may trigger the Cloud fallback');

  const denied = new Error(DESKTOP_ATTACHMENT_ACCESS_DENIED_MESSAGE);
  await assert.rejects(
    withDesktopAttachmentPathFallback('/Users/example/a.pdf', null, async () => { throw denied; }),
    denied,
  );
  await assert.rejects(
    withDesktopAttachmentPathFallback('/Users/example/a.pdf', async () => null, async () => { throw denied; }),
    denied,
  );
  await assert.rejects(
    withDesktopAttachmentPathFallback('/Users/example/a.pdf', async () => '/Users/example/a.pdf', async () => { throw denied; }),
    denied,
  );
});

test('transcript attachments open through the local attachment command, never the URL opener', () => {
  for (const file of [
    '../src/kordi-app/components/transcriptAttachmentActions.tsx',
    '../src/kordi-app/components/transcriptFileAttachmentLink.tsx',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /openDesktopExternalUrl/, file);
    assert.match(source, /openDesktopLocalAttachment/, file);
    assert.match(source, /withDesktopAttachmentPathFallback/, file);
  }
});

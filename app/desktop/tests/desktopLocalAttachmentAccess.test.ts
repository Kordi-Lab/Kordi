import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  attachDesktopReferencedPath,
  DESKTOP_ATTACHMENT_ACCESS_DENIED_MESSAGE,
  isDesktopAttachmentAccessDenied,
  withDesktopAttachmentPathFallback,
} from '../src/lib/desktopLocalAttachments';

async function withNativeInvoke<T>(
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>,
  run: () => Promise<T>,
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke } },
  });
  try {
    return await run();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

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
  const mediaLibraryAction = readFileSync(
    new URL('../src/kordi-app/components/addAttachmentToMediaLibraryAction.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    mediaLibraryAction,
    /isDesktopAttachmentAccessDenied\(readError\)[\s\S]*downloadAttachmentContent/,
    'saving older sent media falls back to the Cloud copy',
  );
});

test('an @ file reference is registered natively before it is attached', async () => {
  const events: string[] = [];
  const saved = await withNativeInvoke(async (command, args) => {
    events.push(`${command}:${String(args.path)}`);
  }, () => attachDesktopReferencedPath('/Users/example/notes.md', async (paths) => {
    events.push(`save:${paths.join(',')}`);
    return paths.length;
  }));

  assert.equal(saved, 1);
  assert.deepEqual(events, [
    'desktop_chat_attach_reference_path:/Users/example/notes.md',
    'save:/Users/example/notes.md',
  ]);
});

test('a refused @ file reference still reaches the attach step, which reports the reason', async () => {
  const saves: string[][] = [];
  await withNativeInvoke(async () => {
    throw 'Kordi does not attach files from credential locations.';
  }, () => attachDesktopReferencedPath('/Users/example/.ssh/id_ed25519', async (paths) => {
    saves.push(paths);
    return [];
  }));
  assert.deepEqual(saves, [['/Users/example/.ssh/id_ed25519']]);
});

test('every @ file reference menu registers the file natively before attaching it', () => {
  for (const file of [
    '../src/pages/ProjectsPage.tsx',
    '../src/pages/chatsPage.mainComposer.tsx',
    '../src/pages/ChatThreadPanel.tsx',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /onAttachPath: \(path\) => \{ void attachDesktopReferencedPath\(path, /, file);
  }
});

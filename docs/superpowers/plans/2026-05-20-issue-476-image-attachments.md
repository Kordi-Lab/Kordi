# Issue 476 Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Cloud image attachment previews so sent and received images render deterministically, remove the bulky image attachment banner/frame, and add a centered clicked-image lightbox.

**Architecture:** Keep Cloud attachment transport in `features/cloud/cloudAttachments.ts`, make the transcript renderer resolve previewable image URLs from local/cache paths, and keep the lightbox inside `kordi-app/components/transcriptAttachments.tsx`. The sender preview bug is fixed by making Cloud attachment metadata mapping consult the upload-seeded local attachment cache immediately, instead of waiting for a later refresh/download pass.

**Tech Stack:** React 19, Tauri `convertFileSrc`, TypeScript, Node test runner with `tsx --test`, existing Kordi Cloud attachment client.

---

## Root Cause Summary

1. **Sender preview unavailable:** `uploadComposerAttachments()` already stores `attachmentId -> localPath` in `cloudAttachmentLocalPathCache`, but immediate rendering maps the returned Cloud message with `cloudMessageAttachmentToMessageAttachment()`, which ignores that cache. The message therefore renders with `attachmentId` and size/name, but no usable `localPath`, causing the fallback card shown in the screenshot.
2. **Heavy banner/frame:** `AttachmentImageCard` always renders a large fallback panel plus `.app-attachment-image-footer` as a full-width lower strip. Inside the own-message bubble this becomes a large grey banner/container.
3. **No lightbox yet:** `AttachmentImageCard` renders an `<img>` or fallback, but there is no clicked-image modal state or centered overlay.

## File Structure

- Modify `app/desktop/src/features/cloud/cloudAttachments.ts`
  - Add cache-aware mapping helper behavior and test-only cache reset.
- Modify `app/desktop/tests/cloudAttachments.test.tsx`
  - Add regression tests for immediate own-sent Cloud message preview from upload cache.
- Modify `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`
  - Refactor image cards into lightweight clickable previews, compact fallback, and centered lightbox.
- Modify `app/desktop/tests/transcriptAttachments.test.tsx`
  - Add static markup tests for light image card UI and no heavy footer/banner class.
- Optionally modify `app/desktop/src/styles/shell-bubbles.css`
  - Remove/replace old footer/fallback styling hooks if class names remain.

---

### Task 1: Make Cloud attachment mapping use the upload-seeded local cache

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudAttachments.ts`
- Modify: `app/desktop/tests/cloudAttachments.test.tsx`

- [ ] **Step 1: Write the failing regression test**

Append this test to `app/desktop/tests/cloudAttachments.test.tsx`:

```ts
test('cloudMessageAttachmentToMessageAttachment uses upload cache for immediate own-sent preview', async () => {
  const client = {
    async uploadAttachment(_token: string, blob: Blob) {
      return {
        attachmentId: 'att_immediate_preview',
        objectKey: 'attachments/acct/att_immediate_preview',
        sizeBytes: blob.size,
        contentType: blob.type,
        sha256Hex: null,
        finalizedAt: '2026-05-20T00:00:00Z',
      };
    },
  } as Pick<CloudAuthClient, 'uploadAttachment'>;

  await uploadComposerAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      id: 'local-1',
      path: '/tmp/kordi/Screenshot 2026-05-20.png',
      name: 'Screenshot 2026-05-20.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 138 * 1024,
    }],
    readAttachment: async () => [1, 2, 3],
  });

  const mapped = cloudMessageAttachmentToMessageAttachment({
    attachmentId: 'att_immediate_preview',
    name: 'Screenshot 2026-05-20.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 138 * 1024,
  });

  assert.equal(mapped.localPath, '/tmp/kordi/Screenshot 2026-05-20.png');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudAttachments.test.tsx
```

Expected: the new test fails because `mapped.localPath` is currently `null`.

- [ ] **Step 3: Implement cache-aware mapping**

In `app/desktop/src/features/cloud/cloudAttachments.ts`, change `cloudMessageAttachmentToMessageAttachment` to prefer explicit `attachment.localPath`, then the cache:

```ts
export function cachedCloudAttachmentLocalPath(attachmentId: string | null | undefined) {
  const id = attachmentId?.trim();
  return id ? cloudAttachmentLocalPathCache.get(id) ?? null : null;
}

export function clearCloudAttachmentLocalPathCacheForTests() {
  cloudAttachmentLocalPathCache.clear();
}

export function cloudMessageAttachmentToMessageAttachment(attachment: CloudMessageAttachment) {
  const localPath = attachment.localPath ?? cachedCloudAttachmentLocalPath(attachment.attachmentId);
  return {
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    previewUrl: null,
    downloadUrl: null,
    localPath,
    attachmentId: attachment.attachmentId,
  };
}
```

- [ ] **Step 4: Stabilize tests with cache clearing**

Update the import in `app/desktop/tests/cloudAttachments.test.tsx` to include `clearCloudAttachmentLocalPathCacheForTests` and add this near the top:

```ts
import { afterEach } from 'node:test';

afterEach(() => {
  clearCloudAttachmentLocalPathCacheForTests();
});
```

If the file currently imports `{ test }` from `node:test`, change it to:

```ts
import { afterEach, test } from 'node:test';
```

- [ ] **Step 5: Run the cloud attachment tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudAttachments.test.tsx
```

Expected: all `cloudAttachments` tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/features/cloud/cloudAttachments.ts app/desktop/tests/cloudAttachments.test.tsx
git commit -m "Use cloud attachment cache for sent image previews"
```

---

### Task 2: Replace the heavy inline image card with a lightweight preview card

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`
- Modify: `app/desktop/tests/transcriptAttachments.test.tsx`

- [ ] **Step 1: Write static markup tests for the new visual contract**

Replace `app/desktop/tests/transcriptAttachments.test.tsx` with this expanded test file:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttachmentPreview, attachmentPreviewIdentity } from '../src/kordi-app/components/transcriptAttachments';

const imageMessage = {
  role: 'user' as const,
  text: '',
  time: '19:45',
  attachments: [{
    kind: 'image' as const,
    name: 'Screenshot 2026-05-20.png',
    sizeBytes: 138 * 1024,
    attachmentId: 'att_1',
    localPath: null,
    previewUrl: 'https://files.test/preview.png',
    mimeType: 'image/png',
  }],
};

test('attachment image preview identity changes when local cache path becomes available', () => {
  const pending = attachmentPreviewIdentity({
    kind: 'image',
    name: 'Screenshot.png',
    sizeBytes: 68 * 1024,
    attachmentId: 'att_1',
    localPath: null,
    previewUrl: null,
  });
  const cached = attachmentPreviewIdentity({
    kind: 'image',
    name: 'Screenshot.png',
    sizeBytes: 68 * 1024,
    attachmentId: 'att_1',
    localPath: '/tmp/kordi/Screenshot.png',
    previewUrl: null,
  });

  assert.notEqual(cached, pending);
  assert.match(cached, /\/tmp\/kordi\/Screenshot\.png/);
});

test('image attachments render as clickable lightweight previews without heavy footer banner', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentPreview, { msg: imageMessage }));

  assert.match(markup, /data-attachment-image-card="true"/);
  assert.match(markup, /data-attachment-image-preview-trigger="true"/);
  assert.doesNotMatch(markup, /app-attachment-image-footer/);
  assert.doesNotMatch(markup, /bg-black\/10/);
  assert.match(markup, /Screenshot 2026-05-20\.png/);
});
```

- [ ] **Step 2: Run the transcript attachment test and confirm it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptAttachments.test.tsx
```

Expected: the new visual contract test fails because the current card still renders `.app-attachment-image-footer` and has no preview trigger data attribute.

- [ ] **Step 3: Update `AttachmentImageCard` to a light card**

In `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`:

1. Add `X` to the lucide import list.
2. Replace `BrokenImagePreview` with a compact fallback:

```tsx
function BrokenImagePreview({ attachment }: { attachment: MessageAttachment }) {
  return (
    <div className="app-attachment-image-fallback flex h-28 flex-col items-center justify-center gap-2 rounded-[15px] border border-dashed border-current/18 bg-current/[0.035] px-4 text-center">
      <div className="app-attachment-image-fallback-icon flex h-9 w-9 items-center justify-center rounded-2xl border border-current/12 bg-current/[0.04]">
        <ImageOff className="h-4 w-4" />
      </div>
      <div>
        <div className="app-attachment-image-fallback-title text-[11px] font-medium">Preview unavailable</div>
        <div className="app-attachment-image-fallback-name mt-0.5 max-w-[13rem] truncate text-[10px]">{displayAttachmentName(attachment.name, attachment.kind)}</div>
      </div>
    </div>
  );
}
```

3. Replace `AttachmentImageCard` with a lightweight version that has no full-width footer strip:

```tsx
function AttachmentImageCard({ attachment, index, onOpenPreview }: {
  attachment: MessageAttachment;
  index: number;
  onOpenPreview: (attachment: MessageAttachment, previewUrl: string) => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewUrl = attachmentPreviewUrl(attachment);
  const sizeLabel = formatAttachmentSize(attachment.sizeBytes);
  const metadataLabel = [sizeLabel, attachment.formatLabel].filter(Boolean).join(' • ');
  const displayName = displayAttachmentName(attachment.name, attachment.kind);
  const showImage = Boolean(previewUrl && !previewFailed);

  return (
    <div
      key={`${attachment.name}-${index}`}
      data-attachment-image-card="true"
      className="app-attachment-image-card overflow-hidden rounded-[18px] border border-current/10 bg-current/[0.025] p-1.5 shadow-[0_10px_28px_rgba(2,8,23,0.10)]"
    >
      {showImage && previewUrl ? (
        <button
          type="button"
          data-attachment-image-preview-trigger="true"
          onClick={() => onOpenPreview(attachment, previewUrl)}
          className="group block w-full overflow-hidden rounded-[14px] bg-black/5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-sky-400/70"
          aria-label={`Preview ${attachment.name || 'attached image'}`}
        >
          <img
            src={previewUrl}
            alt={attachment.name || 'Attached image'}
            className="block max-h-[320px] w-full object-contain transition duration-150 group-hover:scale-[1.01]"
            onError={() => setPreviewFailed(true)}
          />
        </button>
      ) : (
        <BrokenImagePreview attachment={attachment} />
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[10px] text-current/62">
        <span className="min-w-0 truncate">{displayName}</span>
        <div className="flex shrink-0 items-center gap-2">
          {metadataLabel ? <span className="whitespace-nowrap uppercase tracking-[0.12em]">{metadataLabel}</span> : null}
          <AttachmentActions attachment={attachment} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Thread the new `onOpenPreview` prop from `AttachmentPreview`**

In `AttachmentPreview`, add state before the return:

```tsx
const [lightboxAttachment, setLightboxAttachment] = useState<{ attachment: MessageAttachment; previewUrl: string } | null>(null);
```

Update the image card render call:

```tsx
<AttachmentImageCard
  key={`${attachment.name}-${index}-${attachmentPreviewIdentity(attachment)}`}
  attachment={attachment}
  index={index}
  onOpenPreview={(nextAttachment, previewUrl) => setLightboxAttachment({ attachment: nextAttachment, previewUrl })}
/>
```

Keep the lightbox render for Task 3; for this task, return the existing attachment lists unchanged except for the new prop.

- [ ] **Step 5: Run the transcript attachment test**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptAttachments.test.tsx
```

Expected: tests pass and the markup no longer includes `.app-attachment-image-footer`.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/kordi-app/components/transcriptAttachments.tsx app/desktop/tests/transcriptAttachments.test.tsx
git commit -m "Lighten inline image attachment cards"
```

---

### Task 3: Add centered clicked-image lightbox

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`
- Modify: `app/desktop/tests/transcriptAttachments.test.tsx`

- [ ] **Step 1: Add a static lightbox component test**

Append this test to `app/desktop/tests/transcriptAttachments.test.tsx` after exporting the component in Step 2:

```ts
import { AttachmentImageLightbox } from '../src/kordi-app/components/transcriptAttachments';

test('attachment image lightbox renders as a centered modal with close affordance', () => {
  const markup = renderToStaticMarkup(createElement(AttachmentImageLightbox, {
    attachment: imageMessage.attachments[0],
    previewUrl: 'https://files.test/preview.png',
    onClose: () => {},
  }));

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /data-attachment-image-lightbox="true"/);
  assert.match(markup, /Preview image/);
  assert.match(markup, /Close image preview/);
});
```

- [ ] **Step 2: Implement and export `AttachmentImageLightbox`**

In `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`, add this component above `AttachmentImageCard`:

```tsx
export function AttachmentImageLightbox({ attachment, previewUrl, onClose }: {
  attachment: MessageAttachment;
  previewUrl: string;
  onClose: () => void;
}) {
  return (
    <div
      data-attachment-image-lightbox="true"
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/72 px-5 py-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Preview image"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-[24px] border border-white/14 bg-slate-950/92 shadow-[0_30px_90px_rgba(0,0,0,0.48)]">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-slate-100">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{displayAttachmentName(attachment.name, attachment.kind)}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-slate-400">Image preview</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/8 text-slate-200 transition hover:bg-white/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
            aria-label="Close image preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black/24 p-3">
          <img
            src={previewUrl}
            alt={attachment.name || 'Attached image'}
            className="max-h-[min(78vh,900px)] max-w-full rounded-[16px] object-contain shadow-2xl shadow-black/30"
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3 text-slate-200">
          <AttachmentActions attachment={attachment} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add Escape-key close behavior**

Add `useEffect` to the React import:

```tsx
import { useEffect, useState } from 'react';
```

Inside `AttachmentPreview`, after `lightboxAttachment` state:

```tsx
useEffect(() => {
  if (!lightboxAttachment) return;
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') setLightboxAttachment(null);
  }
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [lightboxAttachment]);
```

- [ ] **Step 4: Render the lightbox from `AttachmentPreview`**

Wrap the existing return content in a fragment and append the modal:

```tsx
return (
  <>
    <div className="flex flex-col gap-2">
      {/* existing image and file attachment lists */}
    </div>
    {lightboxAttachment ? (
      <AttachmentImageLightbox
        attachment={lightboxAttachment.attachment}
        previewUrl={lightboxAttachment.previewUrl}
        onClose={() => setLightboxAttachment(null)}
      />
    ) : null}
  </>
);
```

- [ ] **Step 5: Run transcript attachment tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/transcriptAttachments.test.tsx
```

Expected: both image-card and lightbox tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/desktop/src/kordi-app/components/transcriptAttachments.tsx app/desktop/tests/transcriptAttachments.test.tsx
git commit -m "Add image attachment lightbox"
```

---

### Task 4: Verify sender and receiver Cloud image paths with targeted tests

**Files:**
- Modify only if tests expose additional gaps:
  - `app/desktop/src/features/cloud/useCloudBridgeState.ts`
  - `app/desktop/src/features/cloud/useCloudConversation.ts`
  - `app/desktop/src/features/cloud/cloudBridgeState.ts`

- [ ] **Step 1: Run existing targeted tests that cover attachment flow**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/cloudAttachments.test.tsx \
  tests/cloudBridgeState.test.tsx \
  tests/cloudGroupMessages.test.tsx \
  tests/transcriptAttachments.test.tsx
```

Expected: all pass. If `cloudBridgeState` or group message tests fail because the cache-aware mapper changes `localPath` from `null` to a path after upload, update only the expected object for that test to include the local path.

- [ ] **Step 2: Manual preview smoke in existing Tauri instance**

Use the running issue #476 instance:

```text
http://127.0.0.1:1494/
```

Manual steps:
1. Open a Cloud direct or group chat.
2. Paste or attach a small PNG image.
3. Send it.
4. Confirm the sender bubble immediately shows the actual image, not `Preview unavailable`.
5. Confirm the image card has no large grey lower banner/frame.
6. Click the image and confirm a centered modal opens.
7. Press Escape and confirm it closes.
8. If using a second user, confirm the receiver sees the image after arrival/download.

- [ ] **Step 3: Capture evidence**

Record these outcomes in the final response:

```text
Sender preview: actual image shown immediately
Receiver preview: actual image shown after arrival/download
Inline card: no heavy banner/footer
Lightbox: click opens centered modal; Escape/backdrop/close closes it
```

- [ ] **Step 4: Commit any test expectation updates**

If Task 4 required test expectation updates:

```bash
git add app/desktop/tests/cloudBridgeState.test.tsx app/desktop/tests/cloudGroupMessages.test.tsx
git commit -m "Update cloud attachment preview expectations"
```

If no files changed, skip this commit.

---

### Task 5: Final verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Typecheck**

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: exits 0.

- [ ] **Step 2: Lint**

Run:

```bash
pnpm --dir app/desktop lint
```

Expected: exits 0.

- [ ] **Step 3: Targeted tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/cloudAttachments.test.tsx \
  tests/cloudBridgeState.test.tsx \
  tests/cloudGroupMessages.test.tsx \
  tests/transcriptAttachments.test.tsx
```

Expected: exits 0.

- [ ] **Step 4: Final commit if needed**

If verification caused changes:

```bash
git status --short
git add <changed-files>
git commit -m "Stabilize image attachment preview verification"
```

If no changes, do not create an empty commit.

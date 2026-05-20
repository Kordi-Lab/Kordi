# Issue #476 Image Attachments Design

## Goal

Improve Cloud image attachment sending and rendering so sender and receiver can reliably preview images, and image messages feel native to chat instead of like bulky file containers.

## Scope

In scope:
- Sender-side image preview immediately after send.
- Receiver-side image preview once Cloud attachment metadata/content is available.
- Graceful unavailable/loading states for attachment preview failures.
- Softer inline image attachment UI in light and dark themes.
- Centered lightbox/modal opened from the clicked image only.

Out of scope:
- Multi-image gallery navigation in the modal.
- Editing, annotating, or deleting attachments.
- Server attachment API changes unless current client behavior cannot satisfy deterministic preview.

## UX Design

Inline image attachments render as lightweight image cards inside the message bubble. The card should keep a subtle rounded border/shadow and compact metadata/actions, but remove the large heavy lower frame that makes the image look like a technical file container. Generic pasted-image names can stay hidden or de-emphasized using the existing attachment name helpers.

Clicking an inline image opens a centered lightbox/modal showing only that clicked image. The modal closes via backdrop, close button, or Escape. It can expose existing download/open actions when the attachment has a local path or Cloud attachment id. If the preview cannot be resolved, the inline card shows a friendly unavailable state and keeps download behavior available when possible.

## Architecture

Use the existing attachment model and renderer boundaries:
- `app/desktop/src/features/cloud/cloudAttachments.ts` remains responsible for mapping, upload, download, local cache, and Cloud attachment resolution.
- `app/desktop/src/kordi-app/components/transcriptAttachments.tsx` remains responsible for inline attachment rendering and will own the lightbox UI.
- Existing optimistic/canonical attachment paths remain the sender-side fast path for immediate previews.

The main reliability change is to make attachment preview URL resolution deterministic: prefer a valid local path in native shell, fall back to a safe non-internal preview URL, and keep Cloud attachment id available for download or later resolution. Sender sends should preserve the local stored path in optimistic messages and Cloud upload cache. Receiver message hydration should use `resolveCloudMessageAttachments` for small images and keep a graceful fallback for unresolved/large images.

## Data Flow

### Sender

1. User attaches/pastes an image.
2. Composer stores the file through desktop attachment storage and records a local path.
3. Optimistic transcript message renders image from the local path immediately.
4. Cloud upload maps the returned `attachmentId` to the same local path in the attachment cache.
5. The sent Cloud message merges back without losing the local preview path.

### Receiver

1. Cloud message arrives with attachment metadata.
2. Client maps metadata to transcript attachments.
3. Small image attachments are downloaded through `resolveCloudMessageAttachments`, stored locally, cached by `attachmentId`, and rendered from the local path.
4. If download fails or the file is too large, the UI shows a friendly unavailable preview with download action when possible.

## Error Handling

- Broken image load switches the card to a stable unavailable state instead of flickering.
- Internal object-store URLs are never used directly as browser image URLs.
- Download errors appear inline in the attachment action area using the existing compact red error text.
- The modal only opens when there is a usable preview URL; unavailable images keep the fallback card and actions.

## Testing

Targeted tests should cover:
- Cloud attachment upload preserves local path/cache for sender preview.
- Cloud attachment resolve returns local paths for small received images and falls back gracefully when download fails or attachment is too large.
- Transcript attachment rendering exposes clickable image cards for previewable images.
- Lightbox opens for the clicked image and closes through close controls/Escape.
- Image card markup no longer includes the heavy footer/frame styling.

Verification commands:
- `pnpm --dir app/desktop typecheck`
- `pnpm --dir app/desktop lint`
- Targeted tests for cloud attachments and transcript attachments.

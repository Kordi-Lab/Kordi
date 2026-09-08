# Live Photos

Kordi keeps a Live Photo as one image attachment with its original paired MOV and a separate MP4 playback rendition. The original photo and MOV retain their pairing metadata so the pair can be reconstructed in Photos. Thumbnails are separate JPEG previews. Image dimensions describe the original photo, independently of the thumbnail size.

## Sending and viewing

- **iPhone:** Open the paperclip menu and choose Photo Library. Live Photos have the concentric-circle Live Photo symbol. Select a photo and choose **Review Live Photo** to play its motion and sound before sending. Turn off **Send as Live Photo** to explicitly disable motion. Editing a Live Photo requires confirming a still-image result.
- **Mac:** Export a Live Photo's unmodified originals from Photos, then select both the photo and MOV in Kordi's attachment picker. PhotoKit validates the pair regardless of filenames. The composer combines a valid pair into one attachment with the Live Photo symbol; its review button plays the motion before sending.
- **Received photos:** Open the image and activate the **Live Photo** icon. iPhone uses native Live Photo playback and press-and-hold after loading. Mac plays the MP4 in the still image's frame and returns to the still at the end. Replaying in the same viewer reuses the buffered video without preparing another URL or loading the file again; closing or navigating releases it. Motion loads on demand; errors retain the still and offer retry. Live controls sit in the toolbar outside the photo. iPhone previews fit the complete image between the header and footer in portrait and landscape.
- **Save:** On iPhone, use **Save Live Photo** in the viewer. On Mac, **Download Live Photo originals** saves the photo and MOV for importing together into Photos. Forwarding uploads the complete pair and playback rendition under the forwarding sender's account.

Mac import accepts at most 16 selected files per pairing operation. Original photos are limited to 32 MiB; the MOV and MP4 are each limited to 256 MiB. A lone image remains an ordinary image. Motion Photo formats from other platforms and a custom Live Photo editor are outside this implementation.

## Transport

The ordinary image metadata gains an optional `livePhoto` object:

```json
{
  "attachmentId": "photo-id",
  "kind": "image",
  "name": "Photo.heic",
  "mimeType": "image/heic",
  "sizeBytes": 100,
  "livePhoto": {
    "video": { "attachmentId": "motion-id", "name": "Live.mov", "mimeType": "video/quicktime", "sizeBytes": 200 },
    "playback": { "attachmentId": "playback-id", "name": "Live.mp4", "mimeType": "video/mp4", "sizeBytes": 300 }
  }
}
```

All three IDs belong in the canonical request's `attachment_ids`, while `legacy_attachments` contains one logical image. Existing JSON storage and attachment membership links preserve the references without a database migration. Before publication, the server checks linkage, ownership, finalization, detected media types, and actual sizes for all resources. The existing authenticated download and playback routes apply to every component. Clients must finish every upload and store a still preview before sending; they must not silently fall back to a still when motion fails.

Older clients can render the image through the existing JPEG preview endpoint and ignore the optional Live metadata. Client-side native reconstruction validates that the original files constitute a Live Photo; MIME verification on the server is not a substitute for PhotoKit pair validation.

## Validation

No media files are checked in. `scripts/prepare-live-photo-test-assets.sh` generates a synthetic 4000 × 3000 photo paired with a small video, validates it with PhotoKit, verifies byte-preserving import, and exports MP4 playback. The iOS test target invokes it when building test resources. Desktop browser tests invoke it on macOS before exercising playback in Chromium and WebKit.

```bash
bash scripts/prepare-live-photo-test-assets.sh .build/live-photo-fixture
pnpm --dir app/desktop exec tsx --test tests/livePhotos.test.tsx
pnpm --dir app/desktop test:visual livePhoto.spec.ts
```

Use the **Kordi Beta** scheme and a task-owned simulator for iOS tests. The photo-library import test is simulator-only. Open Photo Library in the task-owned Beta app and choose Allow Full Access before running that optional test; it skips when permission has not been granted, so an unattended test never waits on a privacy prompt. It adds a generated asset to that simulator; discard the task-owned simulator after validation. The other native reconstruction tests need no library access.

Before release, verify a physical-device photo with audio, an iCloud-only photo, a photo edited in Photos, and forwarding/save-back between iOS and macOS against the isolated backend.

When launching Beta against a real development account, pass `--disable-preview-data`. Demo mode can persist from an earlier preview launch; demo sends remain local and are not deliveries to the development server.

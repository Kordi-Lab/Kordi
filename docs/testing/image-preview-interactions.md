# Desktop image preview interactions

This follow-up covers the remaining image interaction gaps from #417. The accepted
folded image groups and separate resizable native gallery from #1014, #1017, and
#1079 remain the intended design. The original grid and same-window modal proposals
are superseded by those later changes.

## Behavior

- Clicking a fitted image displays one decoded image pixel per CSS pixel; clicking
  again fits it to the window. Actual size remains reachable for images requiring
  more than the usual four-times-fit zoom limit.
- Scrolling over the image zooms it. Dragging a zoomed image pans it without
  closing the window or treating the drag as a click.
- The percentage remains relative to the fitted image. The reset button and
  Command/Control+0 fit the image to the window. The reset tooltip now describes
  that behavior instead of incorrectly claiming actual size.
- The image context menu offers Copy image. It reads the original local attachment
  or authenticated cloud attachment, never a thumbnail. Other image formats are
  converted to PNG at their decoded natural resolution for clipboard compatibility.
  Animated images and Live Photos copy a still image; Download retains the originals.
- Copying and success are visible in the menu. Permission denial, unavailable
  clipboard support, and image decoding failure report an error without claiming
  success. Clipboard writes start in the user gesture, before asynchronous loading,
  as required by WebKit.
- Existing gallery navigation, Escape, outside-click dismissal, downloads, native
  open actions, image groups, sender avatars, and Live Photo controls are retained.

## Automated checks

- `attachmentImageClipboard.test.tsx`: native original bytes, authenticated original
  selection, synchronous clipboard activation, pending/success/failure UI,
  unsupported clipboard, thumbnail exclusion, natural-resolution conversion, and
  object URL cleanup.
- `transcriptAttachmentLightbox.test.tsx`: six-times-fit actual size, wheel zoom,
  reset, sibling navigation, and Escape while the context menu is open.
- `mediaLightboxGallery.spec.ts`: rendered width equals decoded natural width,
  wheel zoom, drag displacement without accidental dismissal, and return to fit.
  This is a synthetic component fixture, not a complete-product demo.
- Existing attachment, mixed-message, sender-avatar, folded-group, and Live Photo
  regression suites remain applicable.

## Native acceptance checklist

Use existing synthetic images in an isolated development client. Do not send
messages or upload additional media for this check.

1. Open an image in the native gallery. Confirm image-click actual size, wheel
   zoom, drag panning, reset, sibling buttons/arrow keys, and Escape.
2. Open the image context menu, choose Copy image, and verify the copied synthetic
   pixels through a local paste destination. Do not inspect prior clipboard data.
3. Download the image and compare it with the original. Check that the native open
   action is available after downloading.
4. Check the complete conversation page still includes its real navigation and
   actions, mixed attachments, caption, sender identity, and group disclosure.

The baseline native audit on `ab90e69d32e99f20e7ea4ddf8219df7b15c409bb` passed
multi-image navigation, button zoom/reset, Escape, and a byte-identical synthetic
PNG download. It reproduced absent click/wheel zoom and Copy image. Native
acceptance of this follow-up remains pending because the UI observation service
returned a ScreenCaptureKit invalid-parameter error after the scoped frontend
update. Browser checks do not establish native clipboard success. Keep #417 open
until that remaining acceptance is recorded.

Agent image retrieval is separate: #2194 was resolved by #2208 with fresh synthetic
multi-image reading and an unchanged human read cursor. This frontend follow-up
does not change or re-test agent retrieval.

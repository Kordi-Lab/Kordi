# Desktop image preview interactions

This follow-up covers the remaining image interaction gaps from #417. The accepted
folded image groups and separate resizable native gallery from #1014, #1017, and
#1079 remain the intended design. The original grid and same-window modal proposals
are superseded by those later changes.

## Behavior

- Image fitting uses 16-pixel side gaps, a 38-pixel native titlebar, and a
  48-pixel footer. Previous/next buttons share the footer with the count and zoom
  controls. Below 440 pixels wide, navigation uses a second footer row. Complete
  image pixels and aspect ratio are preserved; video fitting is unchanged.
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
  It also checks uncropped maximal fit and nonoverlapping controls for landscape,
  portrait, and square images at 905x650, 1440x900, 720x1100, 520x360, and 320x360.
  The matrix includes a three-digit gallery count, zoom percentage, and the Live
  Photo button. Four gallery snapshots were inspected and updated; the fixture
  backdrop now stays behind the actual gallery. This is a synthetic component
  fixture, not a complete-product demo.
- Existing attachment, mixed-message, sender-avatar, folded-group, and Live Photo
  regression suites remain applicable.

The same-dependency production build grows from 5,608,287 budgeted application
bytes on the baseline to 5,612,188 bytes with this feature, a 3,901-byte increase.
The application allowance increases by 4,000 bytes to 5,613,000; the individual
JavaScript chunk and separate asset/license limits remain unchanged. This leaves
812 bytes of application headroom. Both builds contain 41 JavaScript chunks and
use the same dependencies. Existing image helpers generate reduced/compressed
previews or edited images; they do not provide original-resolution PNG clipboard
data. The new helper reuses existing authentication and attachment readers, and
loads/decodes bytes only when Copy image is invoked. The focused allowance follows
the measured feature-budget approach used in #2210 rather than exempting new code
from the check.

After reconciling main at `13731b61c`, the same production build contains 5,612,739
budgeted application bytes, leaving 261 bytes under the unchanged 5,613,000 cap.
The six image interaction source files remain unchanged by that integration.
The compact-fit CSS adds 211 bytes, bringing the final build to 5,612,950 budgeted
application bytes with 50 bytes of headroom. No further allowance was added.

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
PNG download. It reproduced absent click/wheel zoom and Copy image.

Native follow-up on `a210ea3382a262d2d400415519ffcaad18d7d019` confirmed image-click
zoom from 100% to 106% of fit and wheel zoom from 106% to 131%. The new instructions
and corrected Fit to window tooltip were visible. Copy image displayed success;
an immediate recopy and local Preview paste showed the expected synthetic K6P8,
three orange squares, and purple circle. Preview Inspector reported PNG at
1280 by 800 pixels, matching the source dimensions. An earlier paste after a long
application switch showed a different clipboard image, so only the immediate
controlled recopy/paste is accepted as evidence.

The UI observation service again returned ScreenCaptureKit capture errors before
automated drag and close/return checks could finish. The human then explicitly
confirmed in the coordinating QA conversation that zoomed panning and Escape
close/return to the original chat both work in Alex. Those two checks are
human-confirmed, not automation results. The six applied image interaction source
files were verified unchanged at integrated head `8628925b0`.

The earlier gesture/copy scope is accepted through that controlled evidence and
human confirmation. The subsequent compact-fit layout is applied to the same
isolated client, but its native visual and pan/reset acceptance is still pending
human review because screen capture again failed. No messages, uploads, or model
calls were made. Browser geometry checks remain complementary evidence. Keep #417 open until the
reviewed fix is merged with required CI passing on its final head.

Agent image retrieval is separate: #2194 was resolved by #2208 with fresh synthetic
multi-image reading and an unchanged human read cursor. This frontend follow-up
does not change or re-test agent retrieval.

## Compact-fit measurements

The reference is approximately 1810x1300 physical pixels at a two-times display
scale, corresponding to a 905x650 CSS viewport. The same 1.6-aspect landscape
fixture was measured before and after the padding change in that logical viewport:

| Measurement (CSS pixels) | Before | After |
| --- | ---: | ---: |
| Image width | 760.2 | 873 |
| Image height | 475.1 | 545.6 |
| Left/right gutter | 72.4 | 16 |
| Top gutter | 91.9 | 47.2 |
| Bottom gutter | 82.9 | 57.2 |

Image area increases by approximately 32%. At two-times display scale, the new
side gutters are 32 physical pixels and vertical gutters are approximately 94/114.
These are browser measurements against the old CSS, not claimed native captures.
Letterboxing remains where the source and viewport aspect ratios differ. The
native initial size remains 1080x760 with a 520x360 minimum; a resized window keeps
its user-selected dimensions, and no source pixels are cropped or rewritten.

# Composer backdrop proposal

Static browser preview for the iPhone chat composer backdrop. Today the composer strip is
transparent: only the message field is glass, so transcript messages that scroll under
the strip stay sharp beside and below the field. The page shows four 393px iPhone-width
panels side by side with synthetic sample data, and each transcript scrolls so messages
can be dragged under the composer. It loads no network resources and changes nothing
outside the page.

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/ios-composer-dilute
python3 -m http.server 8762 --bind 127.0.0.1
# open http://127.0.0.1:8762/
```

Query parameters (kept in sync with the controls): `theme=light|dark`,
`keyboard=0|1`, `scroll=long|mid|end` (`long` puts the long agent bubble under the composer).

- Current: transparent strip; only the field is glass and the text under it stays sharp.
- Option A · Frosted, soft edge (recommended): one full-width band from 12px above the
  field to the bottom of the screen (or the keyboard top): `blur(20px) saturate(1.4)` with
  a wallpaper tint of 42% light / 46% dark, so bubbles stay visible as soft shapes. The top
  22px of the band fade in through a mask, so there is no edge line.
- Option B · Frosted, hairline: Telegram's bar. The same band with a hard top edge, a 0.5px
  hairline, `blur(24px) saturate(1.6)` and a tint of 55% light / 60% dark.
- Option C · Blur only: Option A with a 16% / 20% tint, so the wallpaper colour stays true.

An earlier round used a progressive fade that tinted the band almost solid; the owner
asked for a visible blur under the field instead, which this version shows.

Composer geometry follows `ComposerView.swift` (strip padding 9/10, 50px "+" circle,
50px capsule field, 44px accent circle). With the keyboard up the field uses the two-row
typing layout from `docs/design-previews/model-effort-picker`. The Classic wallpaper is
flat in the app (`KordiChatWallpaper`); the page adds a faint vertical gradient so the
blur reads.

## Native implementation

All three options are one band behind the composer strip in `ConversationView`, drawn as
the strip's background and extended into the bottom safe area, so the transcript
`ScrollView` and its scroll-anchoring logic stay unchanged:

- Option A: `Rectangle().fill(.ultraThinMaterial)` (or `.regularMaterial` in dark mode)
  masked with a `LinearGradient` that is clear for the top 22pt, from 12pt above the field
  to the bottom edge, plus a wallpaper-colour overlay at the tint above.
- Option B: the same band without the mask, with a 0.5pt top hairline in `.separator`.
- Option C: the same band as A with a lower tint.

The field keeps its own glass (`glassEffect` on iOS 26, `ultraThinMaterial` before).
Option A was chosen by the owner on 2026-10-21 and is implemented in `ComposerView.swift`.

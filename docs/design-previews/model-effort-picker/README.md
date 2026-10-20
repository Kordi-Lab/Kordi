# Model and effort picker proposal

Interactive browser-only proposal for issue #1809, based on `origin/main` at
`132af0bed` and the supplied mobile and desktop effort-slider references.
It uses sample conversations and account labels. It does not connect to an API,
authenticate, send messages, or persist route changes outside the page.

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/model-effort-picker
python3 -m http.server 8761 --bind 127.0.0.1
# open http://127.0.0.1:8761/
```

Query parameters: `device=mac|ios`, `theme=light|dark`,
`context=group|session|thread`, `palette=default|ocean|midnight|sand`,
`unavailable=1`, and `state=idle|typing|effort|models|projects`. The URL is kept in
sync as you interact, so the address bar always links to the current state.

| State | iPhone (`device=ios`) | Mac (`device=mac`) |
| --- | --- | --- |
| `idle` (default) | One-line glass field, “+” circle, mic, voice button; no model label | Composer at rest |
| `typing` | Expanded field with a sample draft and the mock keyboard | Focused composer with a sample draft |
| `effort` | Expanded field, blurred backdrop, effort panel | 232px effort popover |
| `models` | Expanded field, blurred backdrop, model list | 288px model list popover |
| `projects` | Chat list mock showing the proposed Projects hierarchy | Not applicable (opens idle) |

The iPhone view is a browser layout proposal, not a native SwiftUI build. Motion is
only enabled under `prefers-reduced-motion: no-preference`.

## iPhone composer

- The composer strip has no background. Only the field is glass
  (`backdrop-filter: blur(18px) saturate(1.4)`, translucent fill, hairline border), and
  the “+” is its own small glass circle.
- Idle: one line with placeholder, mic glyph and accent voice/send circle.
- Focus expands the field in 180ms (height and opacity, ease-out). The text stays on
  top; a second row holds emoji, a spacer, the model label (“6.1 Sol” medium,
  “Light” secondary, 4px apart, no capsule) and the send circle, all on one centre
  line, 8px from the field edges, 12px between the label and the send circle. A mock
  keyboard rises. Tapping the transcript or Done with an empty draft collapses in
  180ms; with a draft it stays expanded.
- While any panel is open, one full-screen layer covers everything from the status bar
  to the home indicator (header, transcript, field, keyboard): blur 16px, saturate 1.3,
  black tint 0.10 light / 0.18 dark, 150ms fade. The panel is the only sharp element.
  Tapping the backdrop closes it and returns the sharp screen with the field still
  focused and the keyboard up. (In this browser prototype the blur is applied to the
  layers beneath, because Chromium's `backdrop-filter` leaves sharp content at clipped
  edges; native SwiftUI should use a full-screen material.)
- Panels are glass: 72% white fill in light, 60% surface in dark, 0.5px border with
  the accent at 15%, soft shadow, radius 20, 16px side margins, width
  `min(screen − 32, 360)`.
- Effort panel: its bottom sits 24px above the field top. Header “6.1 Sol Light ›” opens
  the model list. Slider: 56px track, 44px white thumb at a 6px inset, 8px dots, 16px
  panel padding; thumb and fill animate over 160ms.
- Model list and account pages: centred vertically, at most 60% of the screen tall,
  with the title row and close button pinned while only the rows scroll. Default
  (GPT-6.1 Sol), then GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol,
  More models, divider, “ChatGPT • Work”. Picking applies at once, closes the panel and
  swaps the label with a 180ms fade/slide.
- Slider fill geometry (both platforms): the fill is inset by the thumb inset on the top,
  bottom and leading side, rounds only its leading end with the thumb radius, and ends at
  the thumb centre. iPhone: inset 6px, width `22px + (track − 56px) × t`. Mac: inset 2px,
  width `10px + (track − 24px) × t`. At t = 0 it is exactly the thumb’s leading
  half-disc, so it stays hidden under the thumb.

## Mac composer

The same plain-text label sits beside the send button. The effort popover is 232px wide,
radius 20, padding 12: effort level (accent, 12px) above the model link, then a 24px
capsule track with a 20px thumb whose centre is `12px + (width − 24px) × t`; the fill
ends at the thumb centre (see the fill geometry above) and dots are inset 10px, so nothing
touches the rounded corners. The model list popover is 288px wide with the same radius and glass.

## Projects list (`state=projects`)

Shows the proposed hierarchy for the iPhone chat list. The “Projects ⌄” header is
unchanged. Folder rows are the parents: 44px tall, leading chevron, 20px folder icon,
17px semibold name, status in 13px secondary text at the trailing edge. Session rows
under an expanded folder are indented 28px, 56px tall, with a 15px medium title and a
13px secondary meta line (“Kordi · …”) plus a trailing date. Rows under “Recents” keep
17px semibold titles because they are top level. Folder names and sessions are sample
data.

## Proposed behavior

- One plain-text model label has two targets: model name opens the short model menu;
  effort opens the compact dotted slider. Both paths remain connected through
  the model link. The model menu does not repeat an effort row.
- Model names are readable; Default is first, with additional models in a
  searchable second view. The default model shown is an illustrative fixture.
- Model and effort selections apply immediately. Effort reset delegates to the
  model default rather than asserting that default means a specific level.
- Effort options follow the current iOS model constraints. Production code must
  use the shared discovered catalog and capability metadata, including custom
  providers and unknown model identifiers, rather than this illustrative subset.
- A provider change enters account selection. A shared-account change remains
  staged until confirmation; cancellation leaves the existing route intact.
- An unavailable account remains explicit. Recovery offers signed-in accounts
  of the same provider and requires confirmation in a shared context.
- The same control is proposed for main and thread composers and agent sessions;
  remove redundant header selectors when integrating it.

## Implementation follow-through

Share display-name and route-resolution logic across desktop entry points. Keep
raw identifiers in protocol payloads. Reuse existing permission checks, route
ownership, account-unavailable matching, and compatible-effort fallback logic.
Port the control to native SwiftUI with VoiceOver-adjustable effort selection.

The prototype applies changes in memory. The actual implementation must handle
save failures without announcing success, retain the last confirmed route, and
provide retry. It must also handle empty model catalogs, disconnected accounts,
read-only membership, custom model entry, and catalog loading. Update the existing
`composerModelSelection`, `compactComposerModelMenu`, and `AgentModelRouteUITests`
when implementing the production behavior.

## Native implementation capture

![Native compact effort picker in Sand](../../../app/desktop/tests/visual/__screenshots__/ios-model-effort-sand-synthetic.png)

Captured from the Kordi Beta simulator with offline synthetic preview data.
The real composer uses the selected theme accent and readable model names.

The native iOS refinement uses a 208-point floating effort panel with the level
above the model link and a thin dotted slider. Both menus anchor directly to
the composer model control, preserving the draft and keyboard. The desktop
retains the compact popover shown in this original browser proposal.

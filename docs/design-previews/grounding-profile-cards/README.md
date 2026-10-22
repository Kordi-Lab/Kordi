# Grounding profile cards

Interactive browser-only proposal for showing a person's Grounding profiles as cards in a wallet. Each kind (Work, Health, Daily tasks, Workshop, Research group, Custom) has its own card design with its glyph, name, focus line and shared topics. The page covers the Home wallet (stacked, fanned, with a new-card slot), the Pair code row (four digits join a room, with the card to share chosen in a carousel; Create a code opens a meetup and shows its new code), a live New card editor, and the card detail that flips over to show topics, sources and hide controls. It starts from the current profile UI (chips on Home, the New profile dialog, Pair code, Your card, Rooms) described in `docs/common-ground.md`. People and data are synthetic (Maya, Tomas, Priya, the "Poster session 2026" room); nothing connects to an API, and there are no external scripts, fonts or images. Workshop and Research group are card designs on top of the existing kinds, not new server kinds.

Serve it from this directory, bound to loopback, then open `http://127.0.0.1:8710/`:

```sh
cd docs/design-previews/grounding-profile-cards
python3 -m http.server 8710 --bind 127.0.0.1
```

The scripts are ES modules, so open the page through the server, not as a file. Files:

- `index.html`: the review chrome, the iPhone frame and the Mac window.
- `app.js`: the entry module; the Screen menu, URL state, theme and boot.
- `core.js`: shared helpers, icons and the one state object.
- `data.js`: synthetic people, cards, rooms and references.
- `cards.js`: card markup, the iPhone wallet, layers and the carousel.
- `ios.js`: iPhone rows, the room sheet, New card and the card flip.
- `rooms.js`: the Pair code row, joining by code and Create a code (both modes).
- `mac.js`: the Mac deck rail, action column, popovers and card page.
- `tokens.css`, `cards.css`, `ios.css`, `mac.css`: colour tokens and card palettes, card styles, iPhone styles, Mac styles (loaded in that order).

On the Mac the cards sit in an aligned drawer on the left, the selected one open at full height. Beside it is one action column: the Pair code row (typing four digits shows the room under the boxes with Join, which shares the selected card, and a "Suggested" chip that switches to the room's kind first; Create opens a small popover to name a meetup and pick the card, then shows its four-digit code), Rooms, Recent, and Your card with its topic chips. Open on the selected card, a double-click, or Your card pushes the card page: a slim header with Rebuild from memory, Rename and Delete, then the topics under Working on, Interests, Can help with and Looking for with their references (source, title, snippet, date) and a Hide toggle, the sources that feed the card with a toggle each, and Share my card. New card is one compact dialog with design swatches above a live card, and the first run is a single centred Build block.

Room codes in the preview: 4821 opens Poster session 2026, 3907 and 5160 are rooms you are already in, any other code shows "Room not found".

The Screen menu, the iPhone and Mac switch and the theme button keep the address bar in sync, so every state has a link. Query parameters: `screen`, `mode=ios|mac`, `theme=light|dark`.

iPhone:

- `?screen=wallet&mode=ios&theme=light`: Home wallet, the active card on top
- `?screen=fanned&mode=ios&theme=light`: wallet fanned out
- `?screen=detail&mode=ios&theme=light`: card detail, flipped
- `?screen=room&mode=ios&theme=light`: code 4821 typed; Poster session 2026 suggests Workshop
- `?screen=create&mode=ios&theme=light`: create a code for a meetup
- `?screen=code&mode=ios&theme=light`: the new code, 7 3 1 9
- `?screen=new&mode=ios&theme=light`: New card
- `?screen=empty&mode=ios&theme=light`: empty wallet, first run, one Work card suggested
- `?screen=kaust&mode=ios&theme=light`: a custom card named KAUST in front

Mac:

- `?screen=wallet&mode=mac&theme=light`: Home
- `?screen=detail&mode=mac&theme=light`: card page with references
- `?screen=room&mode=mac&theme=light`: code 4821 typed; Poster session 2026 suggests Workshop
- `?screen=create&mode=mac&theme=light`: create a code for a meetup
- `?screen=code&mode=mac&theme=light`: the new code, 7 3 1 9
- `?screen=new&mode=mac&theme=light`: New card
- `?screen=empty&mode=mac&theme=light`: first run
- `?screen=kaust&mode=mac&theme=light`: the KAUST card selected

Every screen also takes `theme=dark`.

Motion uses CSS transitions of 200 to 300 ms with ease-out and turns off under `prefers-reduced-motion: reduce`.

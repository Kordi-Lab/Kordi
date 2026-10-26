# Grounding nearby

Interactive browser-only proposal for **Grounding › Pair › Nearby people** (issue #2100; contract in `docs/development/grounding-nearby.md`). It draws the shipped Grounding screens (iPhone Home with the wallet and the Pair group, Mac Home with the deck rail and one 540 px column) and adds a Nearby row to the Pair group, the Nearby screen with Open to, People, Looking for and Alerts, the consent sheet or dialog, the request editor, the nearby person with the checks for your requests, the lock-screen alert, and the location and pause states. On the Mac, Nearby reads the location the account's iPhone sends. People and data are synthetic (Maya Chen, Leo Park, Tomas Berg, Priya Nair, Ana Ruiz, Noor Haddad, Sara Lind); nothing connects to an API, and there are no external scripts, fonts or images. Tomas sits exactly at 1 km, Leo at 2 km, Priya at 70% and Ana at 85%, so the Within and match filters show who stays at each edge.

The page shares `tokens.css` and `cards.css` with `../grounding-profile-cards/`, so serve the parent `docs/design-previews` directory, bound to loopback, then open `http://127.0.0.1:8720/grounding-nearby/`:

```sh
cd docs/design-previews
python3 -m http.server 8720 --bind 127.0.0.1
```

The scripts are ES modules, so open the page through the server, not as a file. Files:

- `index.html`: the review chrome, the iPhone frame and the Mac window.
- `app.js`: the entry module; the Screen menu, presets, URL state, theme and boot.
- `core.js`: shared helpers, outline icons and the one state object.
- `data.js`: synthetic people, cards and requests, distance bands and the search order.
- `ios.js`: iPhone Home, the Nearby screen in each state, the nearby person and the lock screen.
- `ios-layers.js`: iPhone sheets (Turn on Nearby?, New and Edit request) and pull-down menus.
- `mac.js`: the Mac frame, Home, the Nearby column and the person page.
- `mac-layers.js`: Mac dialogs (AppDialog) and menus.
- `ios.css`, `mac.css`: iPhone and Mac styles, loaded after the two shared files.

Filters, Open to chips (and + to type one), switches, the menus, Add on Looking for, editing, pausing and deleting a request, Pause, Turn off, Turn on, Add on a person and the alert all work. The Screen menu, the iPhone and Mac switch and the theme button keep the address bar in sync. Query parameters: `screen`, `mode=ios|mac`, `theme=light|dark`.

iPhone:

- `?screen=home&mode=ios&theme=light`: Home, the Nearby row reads 4 people
- `?screen=home-off&mode=ios&theme=light`: Home, Nearby off
- `?screen=home-paused&mode=ios&theme=light`: Home, Nearby paused
- `?screen=off&mode=ios&theme=light`: Nearby off, Turn on
- `?screen=consent&mode=ios&theme=light`: Turn on Nearby? sheet
- `?screen=on&mode=ios&theme=light`: Nearby on
- `?screen=range&mode=ios&theme=light`: the Within menu
- `?screen=score&mode=ios&theme=light`: the match menu
- `?screen=menu&mode=ios&theme=light`: the more menu (pause, turn off)
- `?screen=empty&mode=ios&theme=light`: no one nearby yet
- `?screen=request&mode=ios&theme=light`: New request
- `?screen=request-edit&mode=ios&theme=light`: Edit request, with Paused and Delete request
- `?screen=person&mode=ios&theme=light`: nearby person with your requests
- `?screen=alert&mode=ios&theme=light`: lock screen, request alert
- `?screen=alert-match&mode=ios&theme=light`: lock screen, match alert
- `?screen=limited&mode=ios&theme=light`: only while Kordi is open
- `?screen=denied&mode=ios&theme=light`: location access off
- `?screen=stale&mode=ios&theme=light`: location out of date
- `?screen=paused&mode=ios&theme=light`: paused until 3:00 PM

Mac:

- `?screen=home&mode=mac&theme=light`: Home, the Nearby row reads 4 people from your iPhone
- `?screen=home-off&mode=mac&theme=light`: Home, Nearby off
- `?screen=on&mode=mac&theme=light`: Nearby
- `?screen=range&mode=mac&theme=light`: the Within menu
- `?screen=score&mode=mac&theme=light`: the match menu
- `?screen=menu&mode=mac&theme=light`: the more menu
- `?screen=paused&mode=mac&theme=light`: paused
- `?screen=no-phone&mode=mac&theme=light`: no fresh location from the iPhone
- `?screen=off&mode=mac&theme=light`: Nearby off, Turn on
- `?screen=consent&mode=mac&theme=light`: Turn on Nearby? dialog
- `?screen=request&mode=mac&theme=light`: New request dialog
- `?screen=request-edit&mode=mac&theme=light`: Edit request dialog
- `?screen=person&mode=mac&theme=light`: nearby person with your requests

Every screen also takes `theme=dark`.

Motion uses CSS transitions and animations of 200 to 300 ms with ease-out and turns off under `prefers-reduced-motion: reduce`.

## Icon styles

The Icons switch in the top bar (`icons=current|tint|gradient|plain`, default `tint`) restyles the Grounding row in the Mac Contacts list and the Pair rows (Tap or Pair, Pair code, Nearby) on both devices. Glyphs, sizes and radii stay; only colour changes. Hues come from the Grounding palette: Grounding pink, Tap and Pair violet, Pair code cyan, Nearby amber.

- `current`: today's look, accent wash on the Contacts row and solid accent tiles on the Pair rows.
- `tint`: the glyph in its hue on a faint wash of the same hue.
- `gradient`: a calm two-stop gradient per hue with a white glyph.
- `plain`: no tile, an outline glyph in the text colour.

Real files a chosen style changes: Mac `app/desktop/src/styles/shell-contacts.css` (`.app-common-ground-tile`) and `app/desktop/src/styles/commonGroundWallet.css` (`.cg-pair-icon`, one hue per row in `PairCodePanel.tsx`); iPhone `app/ios/Kordi/Features/CommonGround/CommonGroundPairCodeRow.swift` (`tile(_:)`).

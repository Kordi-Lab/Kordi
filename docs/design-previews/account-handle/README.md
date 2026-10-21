# Custom Kordi ID proposal

Static browser preview for letting people choose their own Kordi ID (for example
`@shuyhere`) instead of only the auto-assigned nine-digit number. Sample data only
(Maya, `maya@example.com`, number `175791355`). It loads no network resources and
changes nothing outside the page.

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/account-handle
python3 -m http.server 8763 --bind 127.0.0.1
# open http://127.0.0.1:8763/
```

Query parameters (kept in sync with the controls): `device=mac|ios`,
`theme=light|dark`, `variant=a|b`,
`state=empty|typing|invalid|taken|saved`. Defaults: `mac`, system theme, `a`, `empty`.
On `state=typing`, pressing Save profile (Mac) or the navigation-bar Save (iPhone)
switches to `saved`.

## Rules shown

3-30 ASCII letters and digits, at least one letter, nothing else, unique
case-insensitively, case preserved as typed. The number stays as a fallback and
keeps working for lookup.

## Variants

- A (recommended): an editable Kordi ID field under Display name. Mac: same grid
  column, fixed `@` inside the field, the number as the placeholder; the read-only
  Kordi ID row is removed. iPhone: a "Kordi ID" row in the profile table, between
  Name and Email.
- B: the same field, plus a read-only "Account number" row on both platforms that
  always shows `@175791355` (iPhone: with a copy glyph).

## States

| State | Field | Validation line | iPhone nav bar | Mac card |
| --- | --- | --- | --- | --- |
| `empty` | empty, placeholder `175791355` | none | Save at 35% | `@175791355` |
| `typing` | `shuyhere`, focused | none | Save | `@175791355` (not saved yet) |
| `invalid` | `shu_yhere`, error border (iPhone: red value) | "Use 3-30 letters and numbers, with at least one letter." | Save | `@175791355` |
| `taken` | `maya`, error border (iPhone: red value) | "That Kordi ID is already taken." | Save | `@175791355` |
| `saved` | `shuyhere` | none | Done | `@shuyhere` |

## Sources

- Mac: `app/desktop/src/pages/CloudAccountSettingsDialog.tsx` (profile panel and
  dialog shell), `kordi-app/components/settingsLayout.tsx` (`SettingsSection`,
  `SettingsRow`, `SettingsNav`), `styles/shell.css` and
  `styles/transient-surfaces.css` (`app-input-shell`, `app-flat-input`,
  `app-flat-input-error`), `styles/theme-palette.css` and
  `styles/theme-shell-controls.css` (default palette, hue 250, and light-theme text
  remaps). The dialog has a real light variant, so both themes are mocked.
- iPhone: `app/ios/Kordi/Features/Profile/AccountSheet.swift` (profile form).

## Known differences from the app

- The iPhone profile follows X's "Edit profile" screen rather than today's
  `Form`: a full-screen page (pure black in dark, white in light), status bar, then a
  navigation bar with "Cancel" left, "Edit profile" centred and "Save" right.
- Save is in the Kordi accent while the draft differs from the saved values
  (`typing`, `invalid`, `taken`), at 35% opacity when unchanged (`empty`), and reads
  "Done" in `saved`. There is no full-width Save button.
- Below the bar, a 393x120 banner: a quiet two-stop gradient from the avatar hue
  (no image), with a hairline bottom edge. The 80pt avatar overlaps the banner by half
  its height, 16pt from the left, ringed 4pt in the page colour. A 40% black overlay
  covers the whole avatar with a white 22pt camera glyph centred on it; the initial
  sits hidden under it. The avatar is the only header control: in the app, tapping
  it opens a sheet with Upload photo and Random avatar (not drawn). The table starts
  16pt below the avatar.
- The fields are a label/value table with full-width hairline dividers and 16pt side
  insets: 52pt minimum rows, a 96pt semibold label column, values at 15pt. Rows, in
  order: Name ("Maya"), Kordi ID, About (two-line sample bio, label top-aligned),
  Location ("Lisbon"), Time zone ("Western European Time, GMT+0"), Website (empty,
  tertiary "Add your website" placeholder), Birthday ("March 4, 1996"), Email
  (read-only), and in variant B Account number (read-only, copy glyph). Editable
  values are in the Kordi accent (#AEC4E3 dark, #365F98 light), read-only ones in the secondary colour. Picker
  rows (Location, Time zone, Birthday) end in a 13pt tertiary chevron-down 16pt from
  the right edge. "Account number" wraps to two lines in the 96pt label column. Only
  the Kordi ID changes in `saved`.
- The Kordi ID value starts with a dim `@`, then the typed ID or the number as a
  tertiary placeholder. On error the value turns destructive red (#FDA4AF dark, #9F1239 light) and one 13pt caption in that red sits
  under it inside the same row, in the value column; no helper text otherwise.
- The last table row has no bottom hairline; after a 24pt gap comes a single red
  "Sign out" row with hairlines above and below. Everything below the navigation bar
  scrolls; in variant B Sign out sits below the fold.
- Mac keeps the real "Save changes" description line and button label; it has no
  "Saved" state today. The Save button colour is the palette accent, an approximation
  of the shared `Button`.
- Icons are hand-drawn stand-ins for Lucide and SF Symbols; the avatar is a neutral
  initials circle; the Mac email verification badge is omitted.
- The Mac profile card is a context sketch showing saved values only.

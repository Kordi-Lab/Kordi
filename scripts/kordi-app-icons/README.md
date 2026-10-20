# Kordi app icons

`icons.mjs` is the source of truth for the paper-cut bird icon and the alternate
colors offered by the App icon setting on iOS and macOS. Every PNG and ICNS file
listed below is generated from it. Do not edit those files by hand.

Regenerate on macOS (needs Google Chrome, `sips`, and `iconutil`):

```sh
node scripts/kordi-app-icons/generate.mjs
```

Outputs:

- iOS: `AppIcon` (white, with dark and tinted appearances), `AppIconBeta` (gray),
  `AppIcon-<key>` alternate icons, and `AppIconPreview-<key>` picker thumbnails in
  `app/ios/Kordi/Resources/Assets.xcassets`.
- Desktop: `icon.png`/`icon.icns` (white), `icon-dev.png`/`icon-dev.icns` (gray
  development icon), `menu-bar-template.png`, runtime Dock icons in
  `app/desktop/src-tauri/icons/app-icons/`, and picker thumbnails in
  `app/desktop/public/app-icons/`.

When adding or renaming a variant, update the iOS picker model, the desktop
`KORDI_APP_ICONS` list, the `APP_ICONS` table in `app_icon.rs`, and the iOS
`ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES` build setting.

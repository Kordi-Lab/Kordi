# In-app Desktop Update Design

## Goal
Add a minimal in-app update button for Kordi Desktop so users do not need to visit GitHub, download a DMG, reinstall, and re-authenticate for every release.

## UX
When a packaged desktop build detects an available update, the Chats header shows a single blue `Update` button. Clicking it starts the update immediately. The app downloads and installs quietly, showing compact progress in the button. When installation finishes, Kordi shows a small restart notice with `Restart` and `Cancel`. `Restart` relaunches the app to complete the update; `Cancel` keeps the current app running until the user restarts later.

No explanatory banner is shown in the normal state. Error state is compact and provides a GitHub releases fallback only if in-app update cannot complete.

## Architecture
Use Tauri's updater plugin in packaged native builds. The frontend owns the button state machine and calls a small TypeScript update service. The backend initializes updater/process plugins and the Tauri config declares the update endpoint. Dev/web builds degrade safely: no update button unless the updater API reports an available update, a test injects an updater adapter, or a developer explicitly launches with `VITE_KORDI_PREVIEW_UPDATE=available` to preview the UI.

## Release requirements
Future releases must publish a Tauri updater manifest and signed update artifacts. Without updater signatures/manifest, the UI can render and tests can pass, but packaged auto-install cannot complete. Release automation must include signed updater metadata before this is considered production-ready for public users.

## States
- `idle`: no button unless an update is available.
- `checking`: optional state used by Settings/dev tests, not shown as a banner.
- `available`: show blue `Update` button.
- `downloading`: button shows compact progress.
- `installing`: button is disabled and says `Installing`.
- `ready`: show restart notice with `Cancel` and `Restart`.
- `failed`: show compact failure with fallback link.

## Scope
This spec covers the in-app button, quiet install state, restart/cancel notice, Tauri updater integration, and tests. It does not redesign release signing/notarization; it only wires the app to consume properly signed updater releases.

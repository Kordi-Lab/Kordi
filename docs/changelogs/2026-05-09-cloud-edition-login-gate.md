# Kordi login gate

- Added the first account login gate for the desktop app.
- Added a Kordi account login/sign-up gate that appears before model-provider onboarding in the native shell.
- Later cleanup removed the old edition switch; `main` now has one product path.
- Added the initial packaged build path for the Tauri DMG.
- Added unit coverage for gate visibility, login copy, avatar setup, and gate precedence over provider auth.
- Restyled the account gate to match the Kordi AI website direction: a smaller Codex-style native login window with a warm paper surface, no inner dark backdrop, three-circle Kordi paint mark, social sign-in placeholders, and sign-up avatar upload/random controls.

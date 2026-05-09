# Cloud Edition login gate

- Added a Local vs Cloud edition flag, defaulting to Local Edition unless `VITE_KORDI_EDITION=cloud` or `KORDI_EDITION=cloud` is set.
- Added a Cloud Edition account login/sign-up gate that appears before model-provider onboarding in the native shell.
- Kept Local Edition provider-first onboarding unchanged by leaving local as the default edition.
- Added a Cloud Edition build script that sets the edition env for the Tauri DMG path.
- Added unit coverage for edition normalization, env precedence, gate visibility, login copy, avatar setup, and gate precedence over provider auth.
- Restyled the account gate to match the Kordi AI website direction: a smaller Codex-style native login window with a warm paper surface, no inner dark backdrop, three-circle Kordi paint mark, social sign-in placeholders, and sign-up avatar upload/random controls.

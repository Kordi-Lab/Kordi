# Cloud Login UI Polish + Random-Avatar Persistence Design

## Goal
On `feature/cloud-edition-login-gate` (PR #334), finish the Cloud Edition login page UI so the random-avatar selection is real (persists across reload) and the avatar visual matches the local app's pixel-character system used everywhere else. Replace the current gradient-only avatar with a seed-driven `IdentityAvatar` (pixel-character SVG) so the cloud signup avatar feels native to Kordi.

## In Scope
- **Replace gradient avatars with `IdentityAvatar` (pixel character).** The "Random avatar" button rerolls a seed string; the rendered avatar is the deterministic pixel character that matches the rest of the app.
- Random-avatar selection (seed or uploaded image) persists across reload.
- Login/signup mode persists across reload, so a refresh inside signup doesn't bounce the user back to login mid-typing.
- Inline visual validation: email field gets a soft invalid ring when non-empty and not a valid email; password field shows a length hint at <8 chars.
- Disabled-affordance polish on social and submit buttons: `title="Coming soon"`, subtle hover treatment, proper disabled cursor.
- Smooth animated transition between login/signup tab pill (CSS transform, no layout shift).

## Out of Scope (Deliberate)
- No backend changes. `bridges/cli/src/serve/cloud_auth.rs` and the rest of the auth foundation stay untouched.
- No real OAuth or email/password flows. Buttons remain disabled placeholders.
- No server-side avatar upload. Uploads stay as local data URLs.
- `cloudSessionStatus` stays `signed-out` until a real auth slice ships.

## Architecture

### New modules (pure, no React imports — easy to test)
- `app/desktop/src/features/cloud/avatarPreference.ts`
  - `type AvatarPreference = { kind: 'seed'; seed: string } | { kind: 'upload'; dataUrl: string }`
  - `readAvatarPreference(storage?: Storage): AvatarPreference | null`
  - `writeAvatarPreference(value: AvatarPreference, storage?: Storage): boolean`
  - `clearAvatarPreference(storage?: Storage): void`
  - `randomAvatarSeed(): string` — produces a stable scoped seed like `cloud-signup:<uuid>`; falls back to a timestamp+random hex when `crypto.randomUUID` is unavailable.
  - Caps `dataUrl` length at ~200KB; oversized payloads are rejected (write returns `false`) so the caller can show a "too large" hint and the previous seed stays in place.
  - Recovers from malformed JSON by clearing the bad entry and returning `null`.
- `app/desktop/src/features/cloud/loginModePreference.ts`
  - `type CloudLoginMode = 'login' | 'signup'` (re-exported from existing loginWindow.ts type)
  - `readLoginModePreference(storage?: Storage): CloudLoginMode | null`
  - `writeLoginModePreference(mode: CloudLoginMode, storage?: Storage): void`

Both modules accept an optional `Storage` arg so unit tests can inject a fake without monkey-patching globals. They no-op when `storage` is undefined and `localStorage` isn't available (SSR-safe).

### Storage keys
- `kordi.cloud.signupAvatar`
- `kordi.cloud.loginMode`

Namespaced under `kordi.cloud.*` so they don't collide with other app state.

### CloudLoginPage changes
- Read both preferences on mount via `useState` initializer. If avatar preference is missing, generate a seed via `randomAvatarSeed()`, persist it, and use it — so the avatar shown is consistent across reloads from the very first paint.
- Keep mode/avatar state local but write through to storage on every change.
- `AvatarPicker`:
  - Renders the existing `IdentityAvatar` (`kind="human"`) using the current seed; passes `imageUrl` when the preference is an upload, so uploads layer on top of the pixel character (matching `IdentityAvatar`'s built-in img overlay behavior).
  - Uses a fixed `avatarKey="cloud-signup-preview"` so the global avatar override map is never consulted for this preview (avoids leaking unrelated stored overrides).
  - On upload, uses the existing `fileToAvatarDataUrl` helper (square-crops + JPEG-compresses to ~256px). If `writeAvatarPreference` returns `false` (over cap or storage error), set a transient `tooLarge` flag shown as a small inline note for ~3s; the previous seed stays in place.
  - On "Random avatar", call `randomAvatarSeed()`, write the new seed, and clear any prior upload state.
- `CloudField` gains optional `validation` prop with `'invalid' | 'hint' | undefined` to drive the styling.
- Tab pill: render a single absolutely-positioned pill that translates between `login` and `signup` slots via `transform: translateX(...)` with a 200ms ease.
- Disabled buttons receive `title="Coming soon"` plus hover overlay (slight diagonal stripe at 6% opacity) to read as intentional.

## Data Flow
```
mount
  └─ readLoginModePreference() ─▶ initial mode
  └─ readAvatarPreference() ─────▶ initial avatar state

user picks random ─▶ setAvatar(...) ─▶ writeAvatarPreference(...)
user uploads ─────▶ FileReader ─▶ size check ─▶ writeAvatarPreference(...) | toast
user toggles tab ─▶ setMode(...) ─▶ writeLoginModePreference(...) ─▶ applyCloudLoginWindowSize(mode)
```

The existing `applyCloudLoginWindowSize(mode)` effect stays as-is so the native window still resizes between login/signup heights.

## Files Touched
- `app/desktop/src/kordi-app/cloud/CloudLoginPage.tsx` — wire persistence, validation, tab transition, disabled polish.
- `app/desktop/src/features/cloud/avatarPreference.ts` *(new)* — preference module.
- `app/desktop/src/features/cloud/loginModePreference.ts` *(new)* — preference module.
- `app/desktop/tests/cloudAvatarPreference.test.tsx` *(new)* — pure unit tests for both helpers (storage stub, size cap, malformed JSON recovery).
- `app/desktop/tests/cloudEdition.test.tsx` — extend with: persisted-mode initial render, persisted-avatar gradient index round-trip, disabled buttons keep `Coming soon` affordance, invalid-email visual hint shows.

## Testing Strategy
- Pure-module tests use a hand-rolled `Storage` stub that mirrors `localStorage`'s string-only contract and a `getItem`/`setItem`/`removeItem` triple. No DOM, no React.
- React render tests use `renderToStaticMarkup` (matches the existing pattern in `cloudEdition.test.tsx`). For state assertions that need interaction (e.g. clicking "Random avatar" then re-rendering), tests pre-seed the storage stub and assert the initial markup, since `renderToStaticMarkup` is one-shot.
- New cases:
  - Seed value round-trips through storage
  - Oversized data URL is rejected (write returns `false`; storage stays empty)
  - Malformed JSON in storage doesn't crash — initial render shows the seed-based pixel character
  - Persisted `signup` mode renders the avatar picker on first paint, with the persisted seed visible in the markup (or a freshly-generated seed if no preference exists)
  - The signup-mode markup contains the IdentityAvatar SVG (i.e. the pixel-character SVG, not the old gradient div)
  - Disabled social buttons carry `title="Coming soon"`
  - Submit button stays disabled regardless of input

Existing assertions in `cloudEdition.test.tsx` stay green; we only add to them.

## Risks
- **localStorage quota** — capping uploads at ~200KB stays well inside any browser quota. If users want larger uploads later, switching to IndexedDB is a separate, easy migration since the helper module is the only consumer.
- **Persistence is per-app** — in Tauri, localStorage is scoped to the app webview, so reloads survive but a different OS user gets a clean slate. Acceptable.
- **No SSR concerns** — desktop only; checks for `typeof window === 'undefined'` keep the helpers safe even if pulled into the existing test harness.

## Verification
- `pnpm --dir app/desktop test:unit -- cloudEdition.test.tsx cloudAvatarPreference.test.tsx --runInBand`
- `pnpm --dir app/desktop typecheck`
- `pnpm --dir app/desktop lint`
- Manual: `VITE_KORDI_EDITION=cloud pnpm --dir app/desktop dev` → confirm reload after picking a random avatar restores the same gradient; reload in signup mode stays in signup mode; oversize upload rejects gracefully.

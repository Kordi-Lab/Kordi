# Light theme alignment + glassmorphism — design spec

**Issue:** [#386](https://github.com/Kordi-AI/Kordi/issues/386)
**Base branch:** `main-cloud` @ `78344de4`
**Status:** Approved by user 2026-05-12.
**Implementation strategy:** Approach 2 — Modern balanced frost. Single PR covering the full rollout (Option A).

---

## Goal

The cloud login page introduced in #385 established a distinctive paper-warm palette in light mode and a frosted-glass surface vocabulary. The rest of the desktop app's light theme is still mostly flat opaque sheets (`box-shadow: none` and uniform `rgba(255,255,255,0.x)` fills), and `backdrop-filter` is only used in a handful of transcript + popover spots. This spec aligns the rest of the app with the login page's visual language and rolls out moderate glassmorphism across both themes.

## Non-goals

- Mobile / touch responsiveness.
- Theme persistence across launches (`themeMode` defaults remain unchanged).
- New motion / animation behaviour.
- Refactoring content-level tokens (mention colours, transcript badges, agent skill chips, markdown link colours, validation reds).
- A11y / `prefers-reduced-transparency` handling — flagged as a follow-up if scroll stutter shows up on Intel Iris.

## Architecture — tokens + surfaces + blur tiers

### Token additions

Additive on top of the existing `theme-tokens.css` token graph. No existing tokens are removed.

```css
.bridge-app {
  --app-glass-blur-frame: 12px;
  --app-glass-blur-float: 8px;
  --app-glass-saturate-frame: 1.06;
  --app-glass-saturate-float: 1.04;
  --app-glass-highlight: rgba(255, 255, 255, 0.05);
  --app-paper-grain: transparent;
}

.bridge-app.theme-light {
  --app-glass-highlight: rgba(255, 253, 248, 0.55);
  --app-paper-grain: oklch(0.35 0.03 82 / 0.04);
}
```

The `--app-glass-*` family describes the filter intensity, inner highlight, and grain — *not* fill colour. Fill colour for frame and float surfaces continues to come from the existing `--app-shell-bg`, `--app-side-bg`, `--app-main-bg`, `--app-session-bg`, `--app-modal-bg`, and popover fills already defined in `theme-tokens.css`; those tokens are re-tuned below.

### Light-mode frame token updates

Promote the login page's paper-warm vocabulary into the shell-level tokens so sidebar, main panel, modals, and composer all sit in the same paper world.

```css
.bridge-app.theme-light {
  --app-shell-bg: linear-gradient(180deg,
      rgba(252, 248, 241, 0.72) 0%,
      rgba(245, 240, 230, 0.68) 100%);
  --app-side-bg: rgba(248, 244, 236, 0.66);
  --app-main-bg: linear-gradient(180deg,
      rgba(252, 248, 241, 0.74) 0%,
      rgba(244, 239, 228, 0.70) 100%);
  --app-session-bg: rgba(248, 244, 236, 0.70);
  --app-modal-bg: rgba(252, 248, 241, 0.78);
  /* --app-card-bg, --app-control-bg, --app-control-hover unchanged. */
}
```

### Dark-mode frame token updates

Same token names, lowered alpha so blur reads through.

```css
.bridge-app {
  --app-shell-bg: rgba(15, 17, 21, 0.62);     /* was 0.88 */
  --app-side-bg: rgba(15, 17, 21, 0.56);      /* was 0.72 */
  --app-session-bg: rgba(15, 17, 21, 0.52);   /* was 0.64 */
  --app-main-bg: rgba(15, 17, 21, 0.62);      /* was 0.78 */
  --app-modal-bg: rgba(17, 19, 24, 0.66);     /* was 0.88 */
}
```

### Surface inventory and blur tiers

| Tier | Selectors | Filter |
|---|---|---|
| **Frame** | `.app-shell`, `.app-side-shell`, `.app-main-panel`, `.app-session-panel`, `.app-modal-panel`, `.app-composer-shell`, `.app-detail-sheet` | `backdrop-filter: blur(var(--app-glass-blur-frame)) saturate(var(--app-glass-saturate-frame))` + `-webkit-` prefix |
| **Float** | `.app-popover`, `[role="listbox"]` / `[role="menu"]` dropdown panels, `.app-control-chip` when floating, tooltip surfaces | `backdrop-filter: blur(var(--app-glass-blur-float)) saturate(var(--app-glass-saturate-float))` + `-webkit-` prefix |
| **No blur** | List rows, inline chips, badges, sidebar nav rows, transcript blocks | Inherit blur from blurred parent — no `backdrop-filter` to avoid GPU compounding |

### Feature-query fallback

Every `backdrop-filter` rule sits inside `@supports (backdrop-filter: blur(12px))`. Outside the block, a fallback rule keeps the frame opaque-ish (alpha `~0.92` of the same paper / dark colour) so environments without support still render a clean panel.

## Visual language — paper, grain, depth

### Paper grain — main shell only

A subtle multiply-blended grain layer painted as a `::before` pseudo-element on `.app-shell`. **Not** on modals, sidebar, main panel, session panel, or detail sheet — those should read cleanly. The grain token defaults to `transparent` in dark mode so the same rule is a no-op there.

```css
.app-shell {
  position: relative;
}

.app-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: repeating-linear-gradient(
    7deg, var(--app-paper-grain) 0 1px, transparent 1px 9px);
  mix-blend-mode: multiply;
  opacity: 0.20;
  border-radius: inherit;
}
```

### Light-mode depth — inner highlight + soft drop shadow

Light mode's framed surfaces gain a paper-warm shadow stack to match the login page. This is the single biggest behaviour change in this spec — surfaces that today carry `box-shadow: none` will gain visible depth.

```css
.bridge-app.theme-light .app-shell,
.bridge-app.theme-light .app-modal-panel,
.bridge-app.theme-light .app-detail-sheet,
.bridge-app.theme-light .app-surface-card {
  box-shadow:
    inset 0 1px 0 var(--app-glass-highlight),
    0 12px 28px rgba(141, 124, 106, 0.10),
    0 4px 8px rgba(141, 124, 106, 0.06);
}
```

### Dark-mode depth bump

No palette change. The existing `--app-shadow-soft` / `--app-shadow-float` keep their values; the new inner top highlight via `var(--app-glass-highlight)` is layered onto frame surfaces for a crisper edge.

### What stays untouched

Content tokens are out of scope. Specifically: chat mention colours, peer / own meta colours, markdown link / link-hover, transcript tool-status colours, agent skill chip colours, validation reds / amber hints, social-button accents on the login page.

`--app-card-bg`, `--app-control-bg`, `--app-control-hover` keep their current values in both themes.

## Migration — file-by-file

### `app/desktop/src/styles/theme-tokens.css`

- Additive: add the `--app-glass-*` and `--app-paper-grain` tokens in both the base (dark) and `.theme-light` blocks.
- Update light-mode `--app-shell-bg`, `--app-side-bg`, `--app-main-bg`, `--app-session-bg`, `--app-modal-bg` to the paper-warm translucent values above.
- Update dark-mode `--app-shell-bg`, `--app-side-bg`, `--app-session-bg`, `--app-main-bg`, `--app-modal-bg` to the lowered-alpha values above.

### `app/desktop/src/styles/shell.css`

- For each frame selector: wrap `background` + `backdrop-filter` in `@supports (backdrop-filter: blur(12px))`. Inside, use the new tokens. Outside, fall back to a higher-alpha version.
- Add `position: relative` to `.app-shell` to anchor the grain `::before`.
- Add the `.app-shell::before` grain rule.
- For float-tier selectors (`.app-popover`, dropdown / listbox panels, tooltip surfaces): same `@supports` pattern at `blur-float`.
- Layer the inner-top highlight onto frame selectors via `box-shadow: inset 0 1px 0 var(--app-glass-highlight), ...` alongside the existing shadow tokens.

### `app/desktop/src/styles/theme-overrides.css`

- Remove the `box-shadow: none` overrides on `.app-shell`, `.app-side-shell`, `.app-main-panel`, `.app-session-panel`, `.app-modal-panel`, `.app-detail-sheet`, `.app-composer-shell`, `.app-surface-card` in the `.theme-light` scope.
- Remove the opaque `background: rgba(255,255,255,0.x)` overrides on frame selectors so the new token-driven translucent fills apply.
- Add the new paper-warm inner-highlight + soft-drop shadow stack for `.theme-light` on those frame surfaces.
- Leave all content overrides untouched: `.bg-slate-*`, `.text-slate-*`, agent-shell rules, transcript badges, mention/quote colours.

### `app/desktop/src/styles/shell-popovers.css`

- Re-point existing `backdrop-filter: blur(?)` declarations to `var(--app-glass-blur-float) saturate(var(--app-glass-saturate-float))` so popovers stay aligned with the token system.

### `app/desktop/src/styles/shell-transcript.css`

- Re-point the two existing `backdrop-filter: blur(6-7px)` spots to `var(--app-glass-blur-float)` for consistency. No new blur is added.

### `app/desktop/tests/themeTokens.test.tsx`

- Add: `--app-glass-blur-frame` / `--app-glass-blur-float` present in both `.bridge-app` and `.bridge-app.theme-light` with the agreed values.
- Add: `--app-paper-grain` is `transparent` in dark and `oklch(0.35 0.03 82 / 0.04)` in light.
- Add: light-mode `--app-shell-bg` contains `rgba(252, 248, 241` and `linear-gradient`.
- Add: dark-mode `--app-shell-bg` is `rgba(15, 17, 21, 0.62)`.
- Update: the existing "composer keeps the outer surface without an inner input pop or divider" test re-anchors to the new shadow stack on `.bridge-app.theme-light .app-composer-shell:focus-within` so it still passes.

### Out of file scope

- No TSX / React component changes.
- No new test files.
- No changes to `KordiApp.tsx`, `CloudLoginPage.tsx`, or the login-page surface from #385.

## Testing

### Automated

- `pnpm typecheck:web` — must exit 0.
- `pnpm --dir app/desktop test:unit` — 651/651 (or higher if more tests have landed) passing.
- `themeTokens.test.tsx` — passes against the new token signatures listed above.

### Manual verification (Tauri dev, cloud edition)

Per the Kordi cloud-preview rule (no Vite-only / browser-only check), run `pnpm --dir app/desktop tauri:dev:profile -- --port <free> --profile issue-386-glass` with `VITE_KORDI_EDITION=cloud KORDI_EDITION=cloud` set, then walk through:

1. Cold launch in dark macOS — workspace (sidebar + main panel + composer) has visible blur reading through to the desktop wallpaper; no light flash on first paint.
2. Toggle macOS appearance → light. Frames switch to paper-warm glass; subtle grain visible on `.app-shell` only (not on inner panels or modals); inner top highlight reads on modals and detail sheets.
3. Open a modal (Settings, Auth) — glass effect reads; no grain inside the modal.
4. Open a popover (model picker, context menu) — tighter 8 px glass; visually distinct from the surrounding frame.
5. Scroll a long transcript — no stutter.
6. Hover a contact — detail sheet glass reads.
7. Drag the window — blur recalculates smoothly.

### Risk-flagged manual cases

- High-contrast desktop wallpaper — read body text on transcript / sidebar; if any contrast issue surfaces, mitigation is a per-token alpha bump, not a token-graph change.
- Intel Iris GPU (if available) — scroll a long transcript; if jittery, flag for a `prefers-reduced-transparency` follow-up (out of scope here).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `backdrop-filter` not supported in some environments | `@supports` query falls back to opaque-ish fills |
| GPU cost on lower-end hardware | Two-tier blur (12 / 8 px) limits compounding; only frame and float surfaces get blur |
| Contrast loss on busy wallpapers | Moderate alphas chosen (0.62 dark, 0.66–0.78 light); per-token bump if a case surfaces |
| Light mode regressions in agent panels / transcript | Content overrides in `theme-overrides.css` are left untouched; refactor only touches frame chrome |
| Snapshot / token tests breaking | `themeTokens.test.tsx` updated in the same PR with the new signatures |

## Acceptance criteria

- [ ] All frame surfaces (`.app-shell`, `.app-side-shell`, `.app-main-panel`, `.app-session-panel`, `.app-modal-panel`, `.app-composer-shell`, `.app-detail-sheet`) carry the new translucent fill + 12 px backdrop-filter + inner top highlight in both themes.
- [ ] All float surfaces (`.app-popover`, listbox / menu dropdowns, tooltips) carry the 8 px backdrop-filter.
- [ ] Light-mode framed surfaces have the paper-warm inner-highlight + soft-drop shadow stack (previously `box-shadow: none`).
- [ ] `.app-shell::before` renders the multiply-blended paper grain in light mode and is a no-op in dark mode.
- [ ] No regressions to content tokens (mentions, badges, agent panels, transcript markup, validation states) in either theme.
- [ ] `pnpm typecheck:web` exits 0.
- [ ] `pnpm --dir app/desktop test:unit` passes; `themeTokens.test.tsx` covers the new tokens.
- [ ] Tauri-dev manual verification checklist above passes in both themes.

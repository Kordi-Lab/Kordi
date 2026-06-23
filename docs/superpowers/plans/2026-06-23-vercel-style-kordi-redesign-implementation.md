# Vercel-style Kordi Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kordi visibly redesigned in a Vercel-inspired style with white/graphite neutral chrome, precise geometry, hairline borders, and contextual accents.

**Architecture:** Extend the existing semantic token system rather than rewriting routing or components. Add concrete design-system tests first, then tune theme tokens and shared CSS surfaces so AppShell/sidebar/composer/popovers/right rail inherit the new visual language.

**Tech Stack:** React 19, Vite, Tauri, CSS custom properties, Node `tsx --test`, `npx impeccable detect`.

---

## File structure

- Modify `docs/superpowers/specs/2026-06-23-vercel-style-kordi-redesign.md` to include exact typography, spacing, radius, and depth rules.
- Modify `app/desktop/tests/themeTokens.test.tsx` to assert the Vercel-style token/geometry contract.
- Modify `app/desktop/src/styles/theme-tokens.css` to make light mode visibly white/black and dark mode graphite/black with reduced transparency/glow.
- Modify `app/desktop/src/styles/shell.css` to make shared shell/sidebar/composer/control surfaces flatter, sharper, and more Vercel-like.
- Modify `app/desktop/src/styles/theme-overrides.css` to remove remaining light-mode glass/blue haze on core surfaces and align agents/settings/contact overrides with neutral surfaces.
- Modify `app/desktop/src/styles/shell-popovers.css` to make menus/popovers crisp, near-opaque, and compact.

## Task 1: Concrete spec and test contract

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-vercel-style-kordi-redesign.md`
- Modify: `app/desktop/tests/themeTokens.test.tsx`

- [x] **Step 1: Add failing tests for Vercel-style token and geometry contract**

Add tests asserting:

```ts
assert.match(lightBlock, /--app-surface-canvas:\s*rgb\(255 255 255\);/);
assert.match(lightBlock, /--app-surface-shell:\s*rgb\(255 255 255\);/);
assert.match(lightBlock, /--app-button-primary-bg:\s*rgb\(17 17 17\);/);
assert.doesNotMatch(lightBlock, /radial-gradient|oklch\([^)]*82/);
assert.match(darkBlock, /--app-surface-canvas:\s*rgb\(0 0 0\);/);
assert.match(darkBlock, /--app-surface-shell:\s*rgb\(10 10 10\);/);
assert.match(themeTokensCss, /--app-radius-control:\s*8px;/);
assert.match(themeTokensCss, /--app-radius-row:\s*12px;/);
assert.match(themeTokensCss, /--app-radius-composer:\s*18px;/);
assert.match(themeTokensCss, /--app-font-size-body:\s*13px;/);
assert.match(themeTokensCss, /--app-line-height-body:\s*20px;/);
```

- [x] **Step 2: Run test to verify red**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx
```

Expected: FAIL because current light canvas is `rgb(248 250 252)`, shell uses gradients/transparency, and geometry tokens do not exist yet.

## Task 2: Token contract redesign

**Files:**
- Modify: `app/desktop/src/styles/theme-tokens.css`
- Test: `app/desktop/tests/themeTokens.test.tsx`

- [x] **Step 1: Update semantic tokens**

Implement:

- Light canvas/shell/rail/panel as white or near-white opaque values.
- Dark canvas/shell/rail/panel as black/graphite opaque values.
- Add geometry tokens:
  - `--app-font-size-body: 13px`
  - `--app-line-height-body: 20px`
  - `--app-radius-control: 8px`
  - `--app-radius-row: 12px`
  - `--app-radius-panel: 16px`
  - `--app-radius-composer: 18px`
  - `--app-radius-popover: 14px`
- Replace decorative page radial gradients with flat/linear neutral backgrounds.
- Make depth 1 border-only and depth 2 tiny shadow.

- [x] **Step 2: Run token tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx
```

Expected: PASS.

## Task 3: Shared shell/composer/control surfaces

**Files:**
- Modify: `app/desktop/src/styles/shell.css`
- Modify: `app/desktop/tests/themeTokens.test.tsx`

- [x] **Step 1: Add CSS assertions for visible surface geometry**

Assert:

```ts
assert.match(shellCss, /\.app-shell\s*{[\s\S]*box-shadow:\s*var\(--app-depth-1\)/);
assert.match(shellCss, /\.app-left-glass\s*{[\s\S]*backdrop-filter:\s*none/);
assert.match(shellCss, /\.app-composer-shell \{[\s\S]*min-height:\s*92px/);
assert.match(shellCss, /\.app-composer-shell \{[\s\S]*border-radius:\s*var\(--app-radius-composer\)/);
assert.match(shellCss, /\.app-icon-button\s*{[\s\S]*border-radius:\s*var\(--app-radius-control\)/);
```

- [x] **Step 2: Run test to verify red**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx
```

Expected: FAIL until shell CSS is updated.

- [x] **Step 3: Update shell CSS**

Implement shell/composer/control geometry and remove frame blur from structural panels.

- [x] **Step 4: Run test to verify green**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx
```

Expected: PASS.

## Task 4: Light overrides and popovers

**Files:**
- Modify: `app/desktop/src/styles/theme-overrides.css`
- Modify: `app/desktop/src/styles/shell-popovers.css`
- Test: `app/desktop/tests/compactComposerModelMenu.test.tsx`
- Test: `app/desktop/tests/composerMentionMenu.test.tsx`

- [x] **Step 1: Update popover/menu surfaces**

Make floating surfaces near-opaque, radius `--app-radius-popover`, depth `--app-depth-3`, no large blur/glow.

- [x] **Step 2: Update light theme overrides**

Make agent/contact/settings surfaces neutral white/gray, not blue-haze or glass-heavy. Keep provider/status accents contextual.

- [x] **Step 3: Run affected tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/compactComposerModelMenu.test.tsx tests/composerMentionMenu.test.tsx tests/themeTokens.test.tsx
```

Expected: PASS.

## Task 5: Verification and preview

**Files:**
- Existing source/tests only

- [x] **Step 1: Run typecheck**

```bash
pnpm --dir app/desktop typecheck
```

Expected: PASS.

- [x] **Step 2: Run visual scanner**

```bash
npx impeccable detect app/desktop/src
```

Expected: no findings.

- [x] **Step 3: Run focused UI tests**

```bash
pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx tests/compactComposerModelMenu.test.tsx tests/composerMentionMenu.test.tsx tests/toolTimeline.test.tsx tests/rightDetailRailCloudTasks.test.tsx tests/workspaceSidebarParticipantSpaces.test.tsx
```

Expected: PASS.

- [x] **Step 4: Open native optimized preview**

Use port `1433` and dev URL `/?kordi-preview=1&theme=light&view=chats&detail=tasks`.

- [x] **Step 5: Commit implementation**

```bash
git add docs/superpowers/specs/2026-06-23-vercel-style-kordi-redesign.md docs/superpowers/plans/2026-06-23-vercel-style-kordi-redesign-implementation.md app/desktop/src/styles app/desktop/tests/themeTokens.test.tsx app/desktop/tests/compactComposerModelMenu.test.tsx app/desktop/tests/composerMentionMenu.test.tsx
git commit -m "feat: apply vercel style kordi redesign"
```

## Self-review

- The plan covers the approved Vercel-style direction.
- No placeholder steps remain.
- Tests are specified before production CSS changes.
- Scope is intentionally focused on shared visible surfaces for an obvious redesign.

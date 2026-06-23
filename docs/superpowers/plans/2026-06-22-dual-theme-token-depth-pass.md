# Dual-Theme Token and Depth Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first dual-theme optimization pass from the design doc: semantic theme tokens, calmer depth/elevation, and normalized shell/composer/floating surfaces for both light and dark mode.

**Architecture:** Keep the existing CSS architecture, but add semantic tokens in `theme-tokens.css` and alias existing tokens to them. Update shell/popover/override CSS to consume the semantic contract while avoiding React render-path changes.

**Tech Stack:** React 19, Vite, Tauri, TypeScript, CSS custom properties, Node test runner.

---

### Task 1: Add tests for semantic dual-theme contract

**Files:**
- Modify: `app/desktop/tests/themeTokens.test.tsx`

- [x] Add assertions for semantic surface/text/border/ring/depth tokens in base and `.theme-light` blocks.
- [x] Add assertions that light mode uses cool-neutral text/divider values, not warm beige control tokens.
- [x] Add assertions that dark mode uses graphite semantic surfaces and reduced depth tokens.
- [x] Run `pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx` and verify failure before production CSS changes.

### Task 2: Implement semantic tokens and aliases

**Files:**
- Modify: `app/desktop/src/styles/theme-tokens.css`

- [x] Add semantic tokens: `--app-surface-*`, `--app-text-*`, `--app-border-*`, `--app-ring-focus`, `--app-depth-*`, `--app-status-*`.
- [x] Alias legacy utility/app tokens to semantic tokens.
- [x] Tune dark mode to graphite/deep-neutral surfaces with restrained borders and depth.
- [x] Tune light mode to neutral-cool paper/ink with no warm beige chrome baseline.
- [x] Run focused theme token test and fix failures.

### Task 3: Normalize shell and composer depth

**Files:**
- Modify: `app/desktop/src/styles/shell.css`
- Modify: `app/desktop/src/styles/theme-overrides.css`

- [x] Replace structural panel shadows with semantic depth tokens.
- [x] Remove warm/gold decorative rail glow from structural dark/light chrome.
- [x] Make composer surface neutral in light mode and crisp in dark mode.
- [x] Keep right detail rail flat and seam-free.
- [x] Run theme/right-rail/sidebar focused tests.

### Task 4: Normalize floating surfaces

**Files:**
- Modify: `app/desktop/src/styles/shell-popovers.css`
- Modify: `app/desktop/src/styles/theme-overrides.css`

- [x] Use semantic floating surface background, border, and depth tokens for composer/model/mention/popover surfaces.
- [x] Reduce dark-mode glow; keep light-mode popovers near-opaque and neutral.
- [x] Run compact composer menu focused tests.

### Task 5: Verify and commit

**Commands:**
- `pnpm --dir app/desktop exec tsx --test tests/themeTokens.test.tsx`
- `pnpm --dir app/desktop exec tsx --test tests/compactComposerModelMenu.test.tsx tests/rightDetailRailCloudTasks.test.tsx tests/workspaceSidebarParticipantSpaces.test.tsx`
- `pnpm --dir app/desktop typecheck`
- `npx impeccable --json app/desktop/src/app app/desktop/src/components app/desktop/src/features app/desktop/src/kordi-app app/desktop/src/pages app/desktop/src/styles`

- [x] Update docs if implementation diverges from plan.
- [x] Commit passing implementation.

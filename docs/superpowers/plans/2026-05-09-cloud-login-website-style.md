# Cloud Login Website Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Cloud Edition login gate to match the Kordi AI website’s simple warm paper and three-dot mark style.

**Architecture:** Keep `CloudLoginPage` as the auth UI component and add a small focused window-sizing helper for native runtime. Add no new dependencies; use small local helper components for the paint mark and form fields. Preserve the existing `KordiAppRoot` gate logic.

**Tech Stack:** React 19, Tailwind CSS utility classes, Node test runner with React server rendering.

---

### Task 1: Website-style Cloud login page

**Files:**
- Modify: `app/desktop/tests/cloudEdition.test.tsx`
- Modify: `app/desktop/src/kordi-app/cloud/CloudLoginPage.tsx`
- Create: `app/desktop/src/features/cloud/loginWindow.ts`
- Modify: `app/desktop/src/KordiApp.tsx`
- Modify: `app/desktop/src-tauri/capabilities/default.json`

- [ ] **Step 1: Write the failing test**

Update the existing Cloud login page tests so they expect `kordi-paint-mark`, `bg-[oklch(0.955_0.026_82)]`, `Welcome to Kordi`, Google/GitHub/X sign-in placeholders, and `Model setup comes next.`, while rejecting visible `Kordi Cloud`, provider-heavy copy, old `Continue with GitHub` wording, and the old dark background. Add a sign-up render test that expects `Upload avatar`, `Random avatar`, and `Name`. Add native window helper tests for compact login/signup sizing and normal app window restoration.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir app/desktop test:unit -- cloudEdition.test.tsx --runInBand`
Expected: FAIL because the current component still renders the dark glass design and old explanatory copy.

- [ ] **Step 3: Write minimal implementation**

Rewrite `CloudLoginPage.tsx` to use a warm paper full-window root, the three-circle Kordi mark, centered Codex-style content, and no dark outside backdrop or inner card shell. Keep Google/GitHub/X placeholders, login/signup tabs, email/password/name fields, disabled submit controls, and only a short “Model setup comes next.” note. In sign-up mode, add local-only avatar upload and random avatar controls. Add native window sizing that sets a smaller centered window for login/signup and restores the normal app size after auth.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir app/desktop test:unit -- cloudEdition.test.tsx --runInBand`
Expected: PASS.

- [ ] **Step 5: Verify quality gates**

Run: `pnpm --dir app/desktop typecheck`, `pnpm --dir app/desktop lint`, `VITE_KORDI_EDITION=cloud pnpm --dir app/desktop build`, and `git diff --check`.
Expected: all pass.

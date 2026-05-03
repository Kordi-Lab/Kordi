# Use Kordi App Model Helper Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src/app/useKordiAppModel.ts` by extracting pure helper logic for mentions, canonical session pruning, metadata, avatars, and participant-space identities.

**Architecture:** Add `app/desktop/src/app/useKordiAppModelHelpers.ts` for pure helpers with focused unit tests. Keep `useKordiAppModel.ts` as the orchestration hook and import helpers instead of defining them inline.

**Tech Stack:** React/TypeScript desktop app, node:test via `tsx --test`, TypeScript typecheck, ESLint.

---

### Task 1: Extract pure app-model helpers

**Files:**
- Create: `app/desktop/src/app/useKordiAppModelHelpers.ts`
- Create: `app/desktop/tests/useKordiAppModelHelpers.test.tsx`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write failing helper tests**

Created tests for mention suggestion exact-match whitespace suppression and canonical session scoped record pruning.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir app/desktop exec tsx --test tests/useKordiAppModelHelpers.test.tsx`

Observed: FAIL with `ERR_MODULE_NOT_FOUND` for `src/app/useKordiAppModelHelpers`.

- [x] **Step 3: Move pure helpers into child module**

Moved mention query/filter helpers, avatar seed helpers, canonical removal helpers, metadata helpers, group participant helpers, participant-space helpers, native shell detection, and participant-space create key helper into `useKordiAppModelHelpers.ts`.

- [x] **Step 4: Run targeted tests**

Run: `pnpm --dir app/desktop exec tsx --test tests/useKordiAppModelHelpers.test.tsx`

Observed: 2 tests passed.

- [x] **Step 5: Run type/lint checks**

Run:

```bash
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
```

Observed: both completed successfully after importing the extracted helpers and retaining existing direct `adminIdentityIdsFromMetadata` uses.

- [x] **Step 6: Run scan and commit**

Run:

```bash
pnpm maintainability:scan -- --min-lines 1000 --limit 20
git diff --check
git add app/desktop/src/app/useKordiAppModel.ts app/desktop/src/app/useKordiAppModelHelpers.ts app/desktop/tests/useKordiAppModelHelpers.test.tsx docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-use-kordi-app-model-helper-split.md
git commit -m "Extract useKordiAppModel pure helpers"
```

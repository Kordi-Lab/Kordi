# Use Kordi App Model Bridge Mentions Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src/app/useKordiAppModel.ts` by extracting Bridge mention-target projection into a focused pure module.

**Architecture:** Add `app/desktop/src/app/useKordiAppModelBridgeMentions.ts` for building chat/project mention targets from desktop Bridge state, local agent state, and the active conversation scope. Keep `useKordiAppModel.ts` responsible for hook orchestration and memoizing the extracted projection.

**Tech Stack:** React/TypeScript desktop app, node:test via `tsx --test`, TypeScript typecheck, ESLint.

---

### Task 1: Extract Bridge mention-target projection

**Files:**
- Create: `app/desktop/src/app/useKordiAppModelBridgeMentions.ts`
- Create: `app/desktop/tests/useKordiAppModelBridgeMentions.test.tsx`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `docs/development/maintainability-boundaries.md`

- [x] **Step 1: Write the failing module-boundary test**

Create `app/desktop/tests/useKordiAppModelBridgeMentions.test.tsx` with a test importing `buildBridgeMentionTargetsByScope` from `../src/app/useKordiAppModelBridgeMentions`. Assert that non-native shells return empty chat/project target arrays.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/useKordiAppModelBridgeMentions.test.tsx
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/app/useKordiAppModelBridgeMentions`.

- [x] **Step 3: Move Bridge mention projection into child module**

Create `app/desktop/src/app/useKordiAppModelBridgeMentions.ts` and move the logic currently inside the `bridgeMentionTargetsByScope` `useMemo` into exported pure function `buildBridgeMentionTargetsByScope(params)`. Import existing mention candidate helpers and `possessiveScopedLabel` there.

- [x] **Step 4: Update orchestration hook imports and memo**

In `useKordiAppModel.ts`, replace the inline `bridgeMentionTargetsByScope` body with a call to `buildBridgeMentionTargetsByScope({ isNativeShell, desktopBridgeState, desktopChatState, activeConvMentionScope })`. Remove now-unused imports from the root hook.

- [x] **Step 5: Run targeted frontend checks**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/useKordiAppModelBridgeMentions.test.tsx
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
```

Expected: targeted test, typecheck, and lint pass.

- [x] **Step 6: Run slice verification and commit**

Run:

```bash
pnpm maintainability:scan -- --min-lines 1000 --limit 25
pnpm check:hygiene
git diff --check
git add app/desktop/src/app/useKordiAppModel.ts app/desktop/src/app/useKordiAppModelBridgeMentions.ts app/desktop/tests/useKordiAppModelBridgeMentions.test.tsx docs/development/maintainability-boundaries.md docs/superpowers/plans/2026-05-03-use-kordi-app-model-bridge-mentions-split.md
git commit -m "Extract useKordiAppModel bridge mention projection"
```

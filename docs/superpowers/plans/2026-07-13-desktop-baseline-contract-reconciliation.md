# Desktop Baseline Contract Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop baseline suite green by updating four exact assertions to the intentional production contracts they cover.

**Architecture:** This is a test-contract reconciliation only. Keep the current transcript flex sizing, owner-scoped shared-agent label, and avatar-bearing group participant payload unchanged; update the three affected test files to assert those exact values.

**Tech Stack:** TypeScript, React source-contract tests, Node test runner, pnpm/tsx.

---

## File Structure

- Modify `app/desktop/tests/shellViewportContainment.test.tsx` — assert the current companion transcript flex sizing.
- Modify `app/desktop/tests/useKordiAppModelBridgeMentions.test.tsx` — assert the restored owner-scoped shared Cloud Agent detail.
- Modify `app/desktop/tests/useKordiAppModelHelpers.test.tsx` — assert avatar metadata in group sync and invite participant payloads.

### Task 1: Reconcile the Four Exact Assertions

**Files:**
- Modify: `app/desktop/tests/shellViewportContainment.test.tsx:35`
- Modify: `app/desktop/tests/useKordiAppModelBridgeMentions.test.tsx:328`
- Modify: `app/desktop/tests/useKordiAppModelHelpers.test.tsx:317-318,366-367`

- [ ] **Step 1: Preserve the reproduced failing baseline as RED evidence**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/shellViewportContainment.test.tsx \
  tests/useKordiAppModelBridgeMentions.test.tsx \
  tests/useKordiAppModelHelpers.test.tsx
```

Expected: 27 tests run, 23 pass, and the four documented stale assertions fail.

- [ ] **Step 2: Update the companion transcript sizing assertion**

Replace the stale assertion in `app/desktop/tests/shellViewportContainment.test.tsx` with:

```ts
assert.match(chatsPage, /scrollClassName="min-h-0 flex-1 overflow-x-hidden overscroll-contain px-3 py-5"/);
```

- [ ] **Step 3: Update the shared Cloud Agent detail assertion**

Replace the stale assertion in `app/desktop/tests/useKordiAppModelBridgeMentions.test.tsx` with:

```ts
assert.equal(projectDriver?.detail, "111's Agent");
```

- [ ] **Step 4: Update both group participant payload expectations**

In each of the two `parentSessionParticipants` arrays in `app/desktop/tests/useKordiAppModelHelpers.test.tsx`, use the exact payload returned by the avatar-preserving bridge builder:

```ts
parentSessionParticipants: [
  { identityId: 'human:me', displayName: 'Testuser2', role: 'admin', bridgeNodeId: 'kd_me', humanId: 'kh_me', agentId: null, avatarKey: 'me', profileImageUrl: null },
  { identityId: 'human:jiaxin', displayName: 'Jiaxin', role: 'person', bridgeNodeId: 'kd_jiaxin', humanId: 'kh_jiaxin', agentId: null, avatarKey: 'jiaxin', profileImageUrl: null },
],
```

- [ ] **Step 5: Run the focused baseline tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/shellViewportContainment.test.tsx \
  tests/useKordiAppModelBridgeMentions.test.tsx \
  tests/useKordiAppModelHelpers.test.tsx
```

Expected: 27 tests pass, zero tests fail.

- [ ] **Step 6: Verify no production files changed**

Run:

```bash
git diff --name-only
```

Expected: only the three test files above and this plan document are listed.

- [ ] **Step 7: Run the complete desktop unit suite**

Run:

```bash
pnpm --dir app/desktop test:unit
```

Expected: command exits zero with zero failed tests.

- [ ] **Step 8: Commit the reconciled contracts**

```bash
git add \
  app/desktop/tests/shellViewportContainment.test.tsx \
  app/desktop/tests/useKordiAppModelBridgeMentions.test.tsx \
  app/desktop/tests/useKordiAppModelHelpers.test.tsx \
  docs/superpowers/plans/2026-07-13-desktop-baseline-contract-reconciliation.md
git commit -m "test: reconcile desktop baseline contracts"
```

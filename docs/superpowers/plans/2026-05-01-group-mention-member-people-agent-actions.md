# Group Mention Member People and Agent Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** In group chats, the `@` menu shows only people in the active group and those people's agents, while send-time `@` outreach/join behavior runs only for agents.

**Architecture:** Keep autocomplete filtering in `mentions.ts` as the shared source of truth, and make it robust to canonical group conversations and group-like conversations identified by `directness`/participant names. Add an agent-only send-time resolution option so person mentions can be inserted as text without starting Bridge outreach.

**Tech Stack:** TypeScript, React hooks, node:test, existing desktop unit test runner.

---

### Task 1: Lock desired group mention scope with failing tests

**Files:**
- Modify: `app/desktop/tests/mentions.test.tsx`
- Modify: `app/desktop/src/features/chat/messageActions/mentions.ts`

- [x] **Step 1: Write failing tests**

Add/adjust tests so `filterBridgeMentionCandidatesForConversation()` returns `bridge-person` and `bridge-agent` rows for Alice and Bob when the active group contains Alice and Bob, and excludes Carol's person/agent rows. Add a fallback-scope test where the conversation has `directness: 'Group chat'` and `participants: ['Host Owner', 'Alice', 'Bob']` but no canonical participant details; it should still exclude Carol.

- [x] **Step 2: Verify red**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx
```

Expected: FAIL because the current implementation excludes group people and does not use fallback group participant names.

- [x] **Step 3: Implement minimal autocomplete filtering**

In `mentions.ts`, include `directness` and `participants` in `MentionScopeConversation`, treat `directness` containing `group` as group scope, add participant-name fallback owner keys, and in group scope filter candidates by owner match without excluding `bridge-person` rows.

- [x] **Step 4: Verify green**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx
```

Expected: PASS.

### Task 2: Make send-time `@` outreach agent-only

**Files:**
- Modify: `app/desktop/tests/mentions.test.tsx`
- Modify: `app/desktop/src/features/chat/messageActions/mentions.ts`
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Modify: `app/desktop/src/features/chat/messageActions/projectMessages.ts`

- [x] **Step 1: Write failing agent-only action tests**

Add a test that `resolveMentionedBridgeTarget('@Alice please join', bridgeState, group, { targetKind: 'bridge-agent' })` returns `null`, while `@AlicesKordi please join` resolves Alice's agent. Keep the existing default resolver behavior for autocomplete/legacy tests.

- [x] **Step 2: Verify red**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx
```

Expected: FAIL because `resolveMentionedBridgeTarget()` does not accept an agent-only target option yet.

- [x] **Step 3: Implement agent-only option and use it for sends**

Add a fourth optional `options` argument to `resolveMentionedBridgeTarget()` with `targetKind?: 'bridge-agent' | 'bridge-person'`. Filter candidates by `options.targetKind` before matching. Update chat and project send paths to pass `{ targetKind: 'bridge-agent' }`.

- [x] **Step 4: Verify focused tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx tests/chatRouting.test.tsx
```

Expected: PASS.

### Task 3: Full verification and commit

**Files:**
- All files above.

- [x] **Step 1: Run full verification**

```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
git diff --check
pnpm --dir app/desktop build
```

Expected: all commands pass; Vite may still print the existing large chunk warning.

- [x] **Step 2: Commit and push**

```bash
git add docs/superpowers/plans/2026-05-01-group-mention-member-people-agent-actions.md app/desktop/tests/mentions.test.tsx app/desktop/src/features/chat/messageActions/mentions.ts app/desktop/src/features/chat/messageActions/chatMessages.ts app/desktop/src/features/chat/messageActions/projectMessages.ts app/desktop/src/features/chat/composerController.types.ts app/desktop/src/app/useKordiAppModel.ts
git commit -m "Scope group mentions to member people and agents"
git push
```

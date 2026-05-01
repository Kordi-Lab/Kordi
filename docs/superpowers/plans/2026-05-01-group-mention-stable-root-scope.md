# Group Mention Stable Root Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale group child sessions and self Bridge duplicates from making the group `@` menu look like it contains every Bridge person/agent.

**Architecture:** Keep mention scoping pure in `mentions.ts`. Resolve legacy group continuations back to their root group conversation before filtering candidates, then remove active-host duplicate Bridge candidates because the local agent is already represented as `My Kordi`.

**Tech Stack:** TypeScript, React hooks, node:test, existing desktop unit test runner.

---

### Task 1: Root group scope and active-host duplicate tests

**Files:**
- Modify: `app/desktop/tests/mentions.test.tsx`
- Modify: `app/desktop/src/features/chat/messageActions/mentions.ts`

- [x] **Step 1: Write failing tests**

Add tests for:
- A legacy child group session with stale Carol participants should use `metadata.continuedFromSessionId` root participants Alice/Bob for mention filtering.
- Active host self person/agent Bridge candidates should be removed because the local agent row is already added separately.

- [x] **Step 2: Verify red**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx
```

Expected: FAIL because `mentionScopeConversationForActiveConversation` and `filterBridgeMentionCandidatesForHost` are not exported yet.

- [x] **Step 3: Implement pure helpers**

In `mentions.ts`, add:
- `mentionScopeConversationForActiveConversation(activeConversation, conversations)`
- `filterBridgeMentionCandidatesForHost(candidates, host)`

- [x] **Step 4: Verify green**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx
```

Expected: PASS.

### Task 2: Use stable scope in composer

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`

- [x] **Step 1: Use root-scoped active conversation**

Derive `activeConvMentionScope` from `mentionScopeConversationForActiveConversation(activeConv, chatConversations)`.

- [x] **Step 2: Filter active-host duplicates**

Call `filterBridgeMentionCandidatesForHost(buildBridgeMentionCandidates(desktopBridgeState), activeHost)` before group filtering.

- [x] **Step 3: Verify focused tests and static checks**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx tests/chatRouting.test.tsx
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
git diff --check
```

Expected: PASS.

# Group Mention Agent Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Limit group-chat `@` suggestions and resolution to agents owned by humans already in the current group, with no person invite rows.

**Architecture:** Add pure mention-scope helpers beside existing mention candidate logic, then use them in both the composer menu construction and send-time mention resolution. Keep non-group chats and project mentions unchanged.

**Tech Stack:** TypeScript, React hooks, node:test, existing desktop unit test runner.

---

### Task 1: Group-scope mention candidate tests

**Files:**
- Modify: `app/desktop/tests/mentions.test.tsx`
- Modify: `app/desktop/src/features/chat/messageActions/mentions.ts`

- [x] **Step 1: Write failing tests**

Add tests that build bridge peers for Alice, Bob, and Carol. Use a group conversation containing Alice and Bob. Assert that `filterBridgeMentionCandidatesForConversation()` returns only Alice and Bob agent candidates, excludes person candidates, and excludes Carol's agent. Assert `resolveMentionedBridgeTarget()` resolves `@AlicesKordi` but returns null for `@CarolsKordi` in that group.

- [x] **Step 2: Verify red**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx
```

Expected: FAIL because `filterBridgeMentionCandidatesForConversation` is not exported yet.

- [x] **Step 3: Implement helper functions**

In `mentions.ts`, add:
- `conversationHasGroupMentionScope(conversation)`
- `bridgeMentionOwnerMatchesConversationHumans(owner, conversation)`
- `filterBridgeMentionCandidatesForConversation(candidates, conversation)`

Group scope is active when `conversation.participantSpaceId` is set or the conversation has more than one non-self human participant. In group scope, allow only `bridge-agent` candidates whose `peer.humanId` or `peer.ownerName` matches one of the group human participants.

- [x] **Step 4: Scope send-time mention resolution**

Update `resolveMentionedBridgeTarget(text, bridgeState, conversation?)` to filter candidates with `filterBridgeMentionCandidatesForConversation()` before matching.

- [x] **Step 5: Verify green**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx
```

Expected: PASS.

### Task 2: Composer menu uses current chat group scope

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/kordi-app/components/composer.tsx`
- Modify: `app/desktop/tests/mentions.test.tsx`

- [x] **Step 1: Add optional owner fields to mention options**

Extend `ComposerMentionOption` with optional `humanId`, `agentId`, and `ownerName` so UI option filtering can use the same ownership data.

- [x] **Step 2: Move chat mention target construction after active conversation is known**

Build the `bridgeMentionTargets` memo after `activeConv` is available. Use `filterBridgeMentionCandidatesForConversation(buildBridgeMentionCandidates(desktopBridgeState), activeConv)` before converting bridge candidates to composer options.

- [x] **Step 3: Keep local agent only when its owner is in the group**

For the local agent row, include `humanId: activeHost?.humanId` and `ownerName: activeHost?.ownerName`. In group scope, show it only if `bridgeMentionOwnerMatchesConversationHumans()` returns true.

- [x] **Step 4: Pass active conversation into chat send resolution**

Update `useChatMessageActions()` calls to `resolveMentionedBridgeTarget(text, desktopBridgeState, activeConv)` for chat sends. Leave project sends unchanged.

- [x] **Step 5: Verify focused tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/mentions.test.tsx tests/chatRouting.test.tsx
```

Expected: PASS.

### Task 3: Full verification and commit

**Files:**
- All modified files above.

- [x] **Step 1: Run full desktop verification**

```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
git diff --check
```

Expected: all pass.

- [x] **Step 2: Commit and push**

```bash
git add docs/superpowers/plans/2026-05-01-group-mention-agent-scope.md app/desktop/src/features/chat/messageActions/mentions.ts app/desktop/src/features/chat/messageActions/chatMessages.ts app/desktop/src/app/useKordiAppModel.ts app/desktop/src/kordi-app/components/composer.tsx app/desktop/tests/mentions.test.tsx
git commit -m "Scope group mentions to member agents"
git push
```

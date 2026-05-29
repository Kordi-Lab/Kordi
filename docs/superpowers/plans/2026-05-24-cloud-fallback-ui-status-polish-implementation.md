# Cloud Fallback UI/Status Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Cloud fallback transcript behavior visually consistent with normal online agent turns while improving typed status/error copy.

**Architecture:** Add pure mapping helpers in `cloudAgentMessages.ts`, typed claim API support in `authClient.ts`, and targeted tests. Avoid adding polling or changing runner deployment behavior.

**Tech Stack:** TypeScript, React app test suite via Node/tsx, existing Cloud auth client.

---

## Files

- Modify: `app/desktop/src/features/cloud/cloudAgentMessages.ts`
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Modify: `app/desktop/tests/cloudAgentMessages.test.tsx`
- Modify: `app/desktop/tests/cloudAuthClient.test.tsx`

## Tasks

### Task 1: Cloud fallback copy helpers

- [ ] Add failing tests in `cloudAgentMessages.test.tsx` for status labels, error notice mapping, and Cloud missing-provider detection.
- [ ] Run the targeted test and confirm red.
- [ ] Implement helpers in `cloudAgentMessages.ts`.
- [ ] Run targeted test and confirm green.

### Task 2: Typed claim client

- [ ] Add failing test in `cloudAuthClient.test.tsx` for `claimCloudAgentRun` request/response shape.
- [ ] Run targeted test and confirm red.
- [ ] Implement types + method in `authClient.ts`.
- [ ] Run targeted test and confirm green.

### Task 3: Verify no visible over-labeling

- [ ] Run existing cloud UI tests that cover agent messages/session actions.
- [ ] Confirm successful turns keep existing `agent-turn` shapes and no new Cloud badge/status is required.

## Verification

```bash
cd app/desktop
pnpm exec tsx --test tests/cloudAgentMessages.test.tsx tests/cloudAuthClient.test.tsx tests/cloudSessionActions.test.ts
pnpm typecheck
```

If typecheck is too broad/blocked by existing drift, record that and run targeted TS tests plus relevant static checks.

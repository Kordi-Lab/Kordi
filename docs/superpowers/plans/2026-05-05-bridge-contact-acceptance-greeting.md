# Bridge Contact Acceptance Greeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-send `i accept your request, let's chat` from the accepter to the requester after approving an incoming Bridge contact request.

**Architecture:** Add a small pure helper in `useBridgeOrchestration.ts` to resolve the auto-greeting target from the active host and request id. After `approveDesktopBridgeContactRequest` succeeds, open/create the direct person conversation and call the existing `sendDesktopBridgeMessage` API, merging returned Bridge state after each step.

**Tech Stack:** React hooks, TypeScript, Tauri desktop bridge commands, Node `tsx --test`.

---

### Task 1: Resolve auto-greeting target

**Files:**
- Modify: `app/desktop/src/features/bridge/useBridgeOrchestration.ts`
- Test: `app/desktop/tests/bridgeContactApprovalGreeting.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACCEPTED_CONTACT_AUTO_MESSAGE,
  bridgeContactApprovalGreetingTarget,
} from '../src/features/bridge/useBridgeOrchestration';
import type { DesktopBridgeHost } from '../src/kordi-app/types';

function host(overrides: Partial<DesktopBridgeHost> = {}): DesktopBridgeHost {
  return {
    id: 'host-1',
    registered: true,
    connected: true,
    serverUrl: 'http://127.0.0.1:17080',
    nodeId: 'kd_me',
    displayName: 'My Kordi',
    ownerName: 'Me',
    endpoint: '',
    tokenPresent: true,
    humanId: 'kh_me',
    discoveryMode: 'open',
    agents: [],
    visiblePeers: [{
      nodeId: 'kd_requester',
      displayName: 'Requester Kordi',
      ownerName: 'Requester',
      runtime: 'person',
      endpoint: '',
      sharedProjects: [],
      humanId: 'kh_requester',
      isContact: false,
    }],
    visiblePeerCount: 1,
    projects: [],
    contactRequests: [{
      requestId: 'req-1',
      requesterNodeId: 'kd_requester',
      targetNodeId: 'kd_me',
      status: 'pending',
      message: null,
      createdAt: '2026-05-05T00:00:00Z',
      direction: 'incoming',
    }],
    ...overrides,
  };
}

test('bridgeContactApprovalGreetingTarget resolves requester for pending incoming approvals', () => {
  assert.equal(ACCEPTED_CONTACT_AUTO_MESSAGE, "i accept your request, let's chat");
  assert.deepEqual(bridgeContactApprovalGreetingTarget(host(), 'req-1'), {
    hostId: 'host-1',
    peerNodeId: 'kd_requester',
    peerDisplayName: 'Requester Kordi',
    peerOwnerName: 'Requester',
    peerRuntime: 'person',
  });
});

test('bridgeContactApprovalGreetingTarget ignores outgoing or already decided requests', () => {
  assert.equal(bridgeContactApprovalGreetingTarget(host({
    contactRequests: [{
      requestId: 'req-1',
      requesterNodeId: 'kd_me',
      targetNodeId: 'kd_other',
      status: 'pending',
      message: null,
      createdAt: '2026-05-05T00:00:00Z',
      direction: 'outgoing',
    }],
  }), 'req-1'), null);

  assert.equal(bridgeContactApprovalGreetingTarget(host({
    contactRequests: [{
      requestId: 'req-1',
      requesterNodeId: 'kd_requester',
      targetNodeId: 'kd_me',
      status: 'approved',
      message: null,
      createdAt: '2026-05-05T00:00:00Z',
      decidedAt: '2026-05-05T00:01:00Z',
      direction: 'incoming',
    }],
  }), 'req-1'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir app/desktop exec tsx --test tests/bridgeContactApprovalGreeting.test.tsx`

Expected: FAIL because `ACCEPTED_CONTACT_AUTO_MESSAGE` and `bridgeContactApprovalGreetingTarget` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Add the constant and helper to `app/desktop/src/features/bridge/useBridgeOrchestration.ts`:

```ts
export const ACCEPTED_CONTACT_AUTO_MESSAGE = "i accept your request, let's chat";

export type BridgeContactApprovalGreetingTarget = {
  hostId: string;
  peerNodeId: string;
  peerDisplayName?: string | null;
  peerOwnerName?: string | null;
  peerRuntime: string;
};

export function bridgeContactApprovalGreetingTarget(
  host: DesktopBridgeState['hosts'][number] | null | undefined,
  requestId: string,
): BridgeContactApprovalGreetingTarget | null {
  const trimmedRequestId = requestId.trim();
  if (!host || !trimmedRequestId) return null;
  const request = (host.contactRequests ?? []).find((candidate) => candidate.requestId === trimmedRequestId);
  if (!request || request.direction !== 'incoming' || request.status !== 'pending') return null;
  const requesterNodeId = request.requesterNodeId.trim();
  const targetNodeId = request.targetNodeId.trim();
  const selfNodeId = host.nodeId?.trim() ?? '';
  if (!requesterNodeId || !targetNodeId || (selfNodeId && targetNodeId !== selfNodeId)) return null;
  const peer = host.visiblePeers.find((candidate) => candidate.nodeId === requesterNodeId);
  return {
    hostId: host.id,
    peerNodeId: requesterNodeId,
    peerDisplayName: peer?.displayName ?? null,
    peerOwnerName: peer?.ownerName ?? null,
    peerRuntime: 'person',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir app/desktop exec tsx --test tests/bridgeContactApprovalGreeting.test.tsx`

Expected: PASS.

### Task 2: Send greeting after approval succeeds

**Files:**
- Modify: `app/desktop/src/features/bridge/useBridgeOrchestration.ts`
- Test: `app/desktop/tests/bridgeContactApprovalGreeting.test.tsx`

- [ ] **Step 1: Wire the existing Bridge send APIs**

Import `sendDesktopBridgeMessage` from `@/lib/desktop`.

- [ ] **Step 2: Implement post-approval send**

In `handleApproveBridgeContactRequest`, compute the target before approving. After approval succeeds, open/create the person conversation and send the greeting:

```ts
const greetingTarget = activeBridgeHost?.id === hostId
  ? bridgeContactApprovalGreetingTarget(activeBridgeHost, requestId)
  : null;
const nextState = await approveDesktopBridgeContactRequest(hostId, requestId);
setDesktopBridgeState(nextState);
setDesktopBridgeError(null);

if (greetingTarget) {
  try {
    const openedState = await openDesktopBridgeConversation(
      greetingTarget.hostId,
      greetingTarget.peerNodeId,
      greetingTarget.peerDisplayName ?? undefined,
      greetingTarget.peerOwnerName ?? undefined,
      greetingTarget.peerRuntime,
    );
    setDesktopBridgeState((current) => mergeDesktopBridgeState(current, openedState));
    const conversationId = buildBridgeConversationId(
      greetingTarget.hostId,
      greetingTarget.peerNodeId,
      greetingTarget.peerRuntime,
    );
    const sentState = await sendDesktopBridgeMessage(conversationId, ACCEPTED_CONTACT_AUTO_MESSAGE);
    setDesktopBridgeState((current) => mergeDesktopBridgeState(current, sentState));
  } catch (greetingError) {
    const detail = greetingError instanceof Error ? greetingError.message : 'Unable to send greeting';
    setDesktopBridgeError(`Contact approved, but unable to send greeting: ${detail}`);
  }
}
```

- [ ] **Step 3: Run targeted tests**

Run: `pnpm --dir app/desktop exec tsx --test tests/bridgeContactApprovalGreeting.test.tsx`

Expected: PASS.

- [ ] **Step 4: Run frontend verification**

Run: `pnpm check:frontend && git diff --check`

Expected: all tests, typecheck, lint, build, and whitespace checks pass.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-05-05-bridge-contact-acceptance-greeting-design.md \
  docs/superpowers/plans/2026-05-05-bridge-contact-acceptance-greeting.md \
  app/desktop/src/features/bridge/useBridgeOrchestration.ts \
  app/desktop/tests/bridgeContactApprovalGreeting.test.tsx
git commit -m "feat: send greeting after accepting bridge contact"
```

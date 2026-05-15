# Remove Localhost kh E2E From Main Cloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the old localhost `kh_*` desktop Bridge end-to-end communication path from `main-cloud` Cloud Edition so Cloud collaboration uses only the Cloud host and Cloud-native APIs.

**Architecture:** This is a deletion cleanup, not a routing/gating change. The `main-cloud` app will remove old localhost Bridge E2E communication from Cloud-facing code: no local Bridge state hook, no Bridge outreach/send branches in the composer, no live Bridge Tauri commands in the Cloud runtime, and no `kh_*` participants. Remaining Bridge-shaped objects are only a temporary Cloud UI adapter backed by Cloud APIs, not old localhost transport. Local model provider localhost support remains in scope and untouched.

**Tech Stack:** React/TypeScript desktop UI, Tauri Rust commands, Node test runner via `tsx --test`, Rust `cargo test`, existing Cloud API clients and canonical session SQLite state.

---

## Definition of clean

Cloud Edition is clean when these are true:

1. The only live collaboration host in Cloud Edition is `CLOUD_HOST_SENTINEL === 'cloud'`.
2. Cloud contact/direct/group/fork/agent-mention flows never call these desktop Bridge commands:
   - `desktop_bridge_state`
   - `desktop_bridge_send_message`
   - `desktop_bridge_create_outreach`
   - `desktop_bridge_poll_mailbox`
   - `desktop_bridge_refresh_realtime_connections`
   - `desktop_bridge_send_presence`
3. Cloud state never merges localhost Bridge hosts/conversations/messages into the Cloud host.
4. Cloud participants and mention targets reject `kh_*` and every non-`acct_*` participant ID.
5. Remaining `desktop-bridge-*` strings are local-only read-model fixtures or non-Cloud product code; they are not live Cloud transport.
6. Cleanup code is maintainable: no new overlong files, no copy-pasted transport branches, no hard-coded account/session IDs outside tests/docs, and no hidden Cloud-vs-localhost conditionals spread across unrelated files.
7. No `isCloudEdition`, `enabled`, or similar routing flag is added to keep old Bridge code dormant in composer/send logic; old localhost Bridge communication code is removed from the `main-cloud` path instead.

---

## Maintainability acceptance criteria

- [ ] No modified source file grows beyond 800 lines unless the PR also extracts focused helpers from that file.
- [ ] Any file already over 800 lines that is touched for meaningful logic must end with fewer lines than it started with, or the PR must include a focused split with a clear reason in the PR body.
- [ ] No new hard-coded production account IDs, session IDs, host IDs, URLs, or `kh_*` strings are introduced outside tests, docs, or cleanup SQL dry-run predicates.
- [ ] Cloud transport constants are centralized in Cloud modules (`CLOUD_HOST_SENTINEL`, Cloud control prefixes, Cloud guard helpers) instead of duplicated literals across chat/app code.
- [ ] No new Cloud-vs-localhost routing flags are introduced in composer, send, contact, group, fork, or agent mention code. Product-level edition checks may remain for auth/startup, but they must not preserve old localhost Bridge E2E communication as a dormant branch.
- [ ] New helpers have single-purpose names and small interfaces; avoid generic “manager” or “handler” helpers that mix contacts, messages, tasks, and runtime control.
- [ ] Tests assert behavior rather than source-code shape whenever practical. Static source checks are allowed only for boundary invariants such as “Cloud hook must not import/call old Bridge commands.”
- [ ] No duplicate Cloud send implementations: direct, group, fork, and agent mention sends must share Cloud validation helpers instead of reimplementing `acct_*`/host checks locally.
- [ ] All remaining legacy Bridge compatibility comments explicitly say whether they are historical fixture only or Cloud UI adapter only. Main-cloud runtime code must not retain Local Edition Bridge communication branches.
- [ ] `pnpm maintainability:scan -- --limit 20` is run before PR review, and the PR notes whether the touched files improved or worsened the top overlong-file list.

---

## File structure

- Create: `app/desktop/src/features/cloud/cloudTransportGuards.ts`
  - Central Cloud-only predicates and assertions for account IDs, host IDs, and target lists.
- Create: `app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts`
  - Static and behavioral guard tests proving Cloud code does not route through old Bridge communication paths.
- Modify: `app/desktop/src/features/cloud/cloudGroupMessages.ts`
  - Use centralized account/host validation and expose Cloud-only target helpers. If this file remains over 800 lines after edits, extract participant/target validation into the new guard module instead of adding more logic here.
- Modify: `app/desktop/src/features/cloud/cloudBridgeState.ts`
  - Remove generic local Bridge merge behavior from Cloud state and rename comments to Cloud host adapter language. Keep this file as a Cloud UI adapter; do not add fetch/persistence/runtime responsibilities.
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
  - Remove `baseBridgeState` input and return Cloud-generated state only. This file is already large; each task touching it must either delete more lines than it adds or extract focused helpers.
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
  - Remove `useBridgeState` / `useBridgeOrchestration` as live collaboration state sources from the `main-cloud` app model. Cloud uses `useCloudBridgeState` only.
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
  - Delete old Bridge outreach/send/open branches from the `main-cloud` composer path. Cloud group/direct sends use Cloud APIs only; do not add `isCloudEdition` or `enabled` routing props.
- Modify: `app/desktop/src/features/chat/messageActions/projectMessages.ts`
  - Delete old Bridge project outreach branches from `main-cloud`; project messages may use local desktop chat/runtime, but not localhost Bridge E2E.
- Modify: `app/desktop/src/lib/desktop.ts`
  - Remove exports for live desktop Bridge communication commands from the Cloud app surface, or move them to local-only modules that are not imported by `main-cloud` UI code.
- Modify: `app/desktop/src-tauri/src/lib.rs`
  - Remove live desktop Bridge communication command registration and automatic realtime refresh scheduling from the Cloud runtime.
- Modify: `app/desktop/src-tauri/src/bridge/**` as needed
  - Delete or quarantine old live localhost Bridge communication modules from the `main-cloud` build path. Do not replace deletion with Cloud-edition guards as the primary solution.
- Modify tests under `app/desktop/tests/*`
  - Rewrite Cloud tests to use `acct_*` and `cloud` fixtures; leave `desktop-bridge-*` fixtures only in local/non-Cloud read-model tests with explicit names.

---

### Task 1: Add Cloud transport guard module and tests

**Files:**
- Create: `app/desktop/src/features/cloud/cloudTransportGuards.ts`
- Test: `app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts`
- Modify: `app/desktop/tests/cloudGroupMessages.test.tsx`

- [ ] **Step 1: Write failing tests for Cloud-only IDs and poisoned `kh_*` data**

Create `app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  assertCloudAccountId,
  cloudAccountIdOrNull,
  isCloudAccountId,
  isCloudHostId,
  rejectNonCloudBridgeTargets,
} from '../src/features/cloud/cloudTransportGuards';

const repoRoot = resolve(import.meta.dirname, '..');

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

test('cloud transport guards accept only Cloud host and acct ids', () => {
  assert.equal(isCloudHostId('cloud'), true);
  assert.equal(isCloudHostId('host-local'), false);
  assert.equal(isCloudAccountId('acct_123'), true);
  assert.equal(isCloudAccountId('kh_123'), false);
  assert.equal(isCloudAccountId('node_123'), false);
  assert.equal(cloudAccountIdOrNull(' acct_abc '), 'acct_abc');
  assert.equal(cloudAccountIdOrNull(' kh_abc '), null);
  assert.equal(assertCloudAccountId('acct_abc'), 'acct_abc');
  assert.throws(() => assertCloudAccountId('kh_abc'), /invalid_cloud_account_id/);
});

test('cloud transport guards reject non-cloud group targets', () => {
  assert.deepEqual(rejectNonCloudBridgeTargets([
    { hostId: 'cloud', nodeId: 'acct_a' },
    { hostId: 'cloud', nodeId: 'acct_b' },
  ]), ['acct_a', 'acct_b']);

  assert.throws(() => rejectNonCloudBridgeTargets([
    { hostId: 'cloud', nodeId: 'acct_a' },
    { hostId: 'local-host', nodeId: 'kh_local' },
  ]), /non_cloud_target_in_cloud_edition/);
});

test('cloud state hook no longer accepts base desktop bridge state', () => {
  const source = readSource('src/features/cloud/useCloudBridgeState.ts');
  assert.doesNotMatch(source, /baseBridgeState/);
  assert.doesNotMatch(source, /mergeCloudBridgeState\(baseBridgeState/);
});

test('cloud app model removes old bridge state hook from main-cloud', () => {
  const source = readSource('src/app/useKordiAppModel.ts');
  assert.doesNotMatch(source, /useBridgeState\(/);
  assert.doesNotMatch(source, /baseBridgeState:\s*baseDesktopBridgeState/);
  assert.doesNotMatch(source, /isCloudEdition:\s*kordiEdition\s*===\s*'cloud'/);
});
```

Add a behavioral test to `app/desktop/tests/cloudGroupMessages.test.tsx`:

```ts
test('cloud group participant normalization rejects kh local ids', () => {
  const participants = cloudGroupUniqueParticipants([
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    { accountId: 'kh_local', displayName: 'Localhost', avatarUrl: null, role: 'person' },
    { accountId: 'node_local', displayName: 'Node', avatarUrl: null, role: 'person' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
  ]);

  assert.deepEqual(participants.map((participant) => participant.accountId), ['acct_a', 'acct_b']);
});
```

- [ ] **Step 2: Run tests to verify the new static tests fail**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudNoLegacyBridgeTransport.test.ts tests/cloudGroupMessages.test.tsx
```

Expected: `cloudNoLegacyBridgeTransport.test.ts` fails because `cloudTransportGuards.ts` does not exist and `useCloudBridgeState.ts` still accepts `baseBridgeState`.

- [ ] **Step 3: Implement `cloudTransportGuards.ts`**

Create `app/desktop/src/features/cloud/cloudTransportGuards.ts`:

```ts
import { CLOUD_HOST_SENTINEL } from './useCloudContacts';

export type CloudBridgeTargetRef = {
  hostId?: string | null;
  nodeId?: string | null;
};

export function cleanCloudTransportText(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function isCloudHostId(value: string | null | undefined): boolean {
  return cleanCloudTransportText(value) === CLOUD_HOST_SENTINEL;
}

export function isCloudAccountId(value: string | null | undefined): boolean {
  return cleanCloudTransportText(value).startsWith('acct_');
}

export function cloudAccountIdOrNull(value: string | null | undefined): string | null {
  const trimmed = cleanCloudTransportText(value);
  return isCloudAccountId(trimmed) ? trimmed : null;
}

export function assertCloudAccountId(value: string | null | undefined): string {
  const accountId = cloudAccountIdOrNull(value);
  if (!accountId) throw new Error('invalid_cloud_account_id');
  return accountId;
}

export function rejectNonCloudBridgeTargets(targets: CloudBridgeTargetRef[]): string[] {
  const accountIds: string[] = [];
  for (const target of targets) {
    if (!isCloudHostId(target.hostId)) throw new Error('non_cloud_target_in_cloud_edition');
    accountIds.push(assertCloudAccountId(target.nodeId));
  }
  return [...new Set(accountIds)].sort();
}
```

- [ ] **Step 4: Run guard tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudNoLegacyBridgeTransport.test.ts --test-name-pattern 'cloud transport guards'
```

Expected: Cloud transport guard tests pass; static source tests still fail until later tasks remove old references.

- [ ] **Step 5: Commit Task 1**

```bash
git add app/desktop/src/features/cloud/cloudTransportGuards.ts app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts app/desktop/tests/cloudGroupMessages.test.tsx
git commit -m "test: add cloud transport guard coverage"
```

---

### Task 2: Centralize Cloud account validation in group messages

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudGroupMessages.ts`
- Test: `app/desktop/tests/cloudGroupMessages.test.tsx`

- [ ] **Step 1: Replace local `isCloudAccountId` with shared guard**

In `app/desktop/src/features/cloud/cloudGroupMessages.ts`, add the import:

```ts
import { cloudAccountIdOrNull, isCloudAccountId, rejectNonCloudBridgeTargets } from './cloudTransportGuards';
```

Remove the local function:

```ts
function isCloudAccountId(value: string): boolean {
  return value.trim().startsWith('acct_');
}
```

Update `uniqueByAccount` so the account ID comes from the shared guard:

```ts
const accountId = cloudAccountIdOrNull(participant.accountId) ?? '';
const displayName = cleanText(participant.displayName) || accountId;
if (!accountId) continue;
```

- [ ] **Step 2: Replace non-Cloud group target splitter with Cloud-only reject helper for Cloud sends**

Keep `nonCloudGroupTargets` exported only for non-Cloud/local tests. Add a Cloud-only helper:

```ts
export function cloudOnlyGroupTargetAccountIds(targets: Array<{ hostId?: string | null; nodeId?: string | null }>): string[] {
  return rejectNonCloudBridgeTargets(targets);
}
```

- [ ] **Step 3: Run group tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudGroupMessages.test.tsx --test-name-pattern 'kh local ids|participant envelopes drop local-only ids'
```

Expected: targeted tests pass.

- [ ] **Step 4: Commit Task 2**

```bash
git add app/desktop/src/features/cloud/cloudGroupMessages.ts app/desktop/tests/cloudGroupMessages.test.tsx
git commit -m "refactor: centralize cloud participant validation"
```

---

### Task 3: Remove local Bridge state merging from Cloud state

**Files:**
- Modify: `app/desktop/src/features/cloud/cloudBridgeState.ts`
- Modify: `app/desktop/src/features/cloud/useCloudBridgeState.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Test: `app/desktop/tests/cloudBridgeState.test.tsx`
- Test: `app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts`

- [ ] **Step 1: Write a failing behavioral test for poisoned base Bridge state**

Add to `app/desktop/tests/cloudBridgeState.test.tsx`:

```ts
test('cloud bridge state ignores poisoned localhost bridge state instead of merging it', () => {
  const account = cloudAccount('acct_me', 'Me');
  const cloudState = buildCloudDesktopBridgeState({
    account,
    contacts: [cloudContact('acct_peer', 'Peer')],
    messagesByPeer: {},
    readInboundMessageIdsByPeer: {},
    activeConversationId: null,
    localAgentTurnsByRequestId: {},
    localAgentRuntimeRoute: null,
    cloudSessionTitlesById: {},
    hiddenCloudSessionIds: new Set(),
    suppressUnscopedSelfAgentConversation: false,
  });

  assert.deepEqual(cloudState.hosts.map((host) => host.id), ['cloud']);
  assert.equal(cloudState.conversations.every((conversation) => conversation.hostId === 'cloud'), true);
});
```

If `cloudAccount` or `cloudContact` helpers do not exist in this file, add explicit fixtures:

```ts
const account = {
  accountId: 'acct_me',
  primaryEmail: 'me@example.com',
  displayName: 'Me',
  avatarUrl: null,
  createdAt: '2026-05-15T00:00:00Z',
  updatedAt: '2026-05-15T00:00:00Z',
};
const contact = {
  id: 'cloud:acct_peer',
  classType: 'people',
  name: 'Peer',
  owner: 'Peer',
  bridgePeerNodeId: 'acct_peer',
  bridgeHumanId: 'acct_peer',
  bridgeAgentId: 'cloud-agent:acct_peer',
  bridgeHostId: 'cloud',
  bridges: ['cloud'],
  discoverableOn: ['cloud'],
  profileImageUrl: null,
  avatarSeed: 'acct_peer',
};
```

- [ ] **Step 2: Delete generic `mergeCloudBridgeState` export**

In `app/desktop/src/features/cloud/cloudBridgeState.ts`, remove this function completely:

```ts
export function mergeCloudBridgeState(
  base: DesktopBridgeState | null,
  cloud: DesktopBridgeState | null,
): DesktopBridgeState | null {
  if (!cloud) return base;
  if (!base) return cloud;
  const cloudHostIds = new Set(cloud.hosts.map((host) => host.id));
  return {
    ...base,
    activeHostId: base.activeHostId ?? cloud.activeHostId,
    hosts: [
      ...base.hosts.filter((host) => !cloudHostIds.has(host.id)),
      ...cloud.hosts,
    ],
    conversations: [
      ...base.conversations.filter((conversation) => !cloudHostIds.has(conversation.hostId)),
      ...cloud.conversations,
    ].sort((left, right) => right.updatedAtMs - left.updatedAtMs),
    localServer: base.localServer.running ? base.localServer : cloud.localServer,
  };
}
```

- [ ] **Step 3: Remove `baseBridgeState` from Cloud hook**

In `app/desktop/src/features/cloud/useCloudBridgeState.ts`, remove `mergeCloudBridgeState` from imports and remove `baseBridgeState` from function arguments and type definitions.

Replace the override merge inside the Cloud state calculation with Cloud-only override selection:

```ts
const generatedWithOverride = cloudBridgeOverride ?? generated;
return applyCloudAgentRuntimeRouteToState(generatedWithOverride, activeRuntimeRoute);
```

Replace the returned merged state memo with the Cloud state directly:

```ts
const mergedBridgeState = cloudBridgeState;
```

- [ ] **Step 4: Stop passing base Bridge state into Cloud hook**

In `app/desktop/src/app/useKordiAppModel.ts`, change the hook call from:

```ts
  } = useCloudBridgeState({
    account: kordiEdition === 'cloud' ? cloudSession.account : null,
    baseBridgeState: baseDesktopBridgeState,
    activeConversationId: activeConvId,
    canonicalSessionState,
    setCanonicalSessionState,
    incrementLocalSessionUnread: incrementUnreadForSession,
    cloudAgentRuntimeRoutesBySessionId,
  });
```

to:

```ts
  } = useCloudBridgeState({
    account: kordiEdition === 'cloud' ? cloudSession.account : null,
    activeConversationId: activeConvId,
    canonicalSessionState,
    setCanonicalSessionState,
    incrementLocalSessionUnread: incrementUnreadForSession,
    cloudAgentRuntimeRoutesBySessionId,
  });
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudBridgeState.test.tsx tests/cloudNoLegacyBridgeTransport.test.ts --test-name-pattern 'poisoned localhost|cloud state hook'
```

Expected: tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add app/desktop/src/features/cloud/cloudBridgeState.ts app/desktop/src/features/cloud/useCloudBridgeState.ts app/desktop/src/app/useKordiAppModel.ts app/desktop/tests/cloudBridgeState.test.tsx app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts
git commit -m "refactor: remove localhost bridge merge from cloud state"
```

---

### Task 4: Remove old Bridge state/orchestration from the main-cloud app model

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`
- Modify: `app/desktop/src/app/useKordiShellArgs.ts` if shell args still require local Bridge handlers
- Modify: `app/desktop/src/app/useKordiShellViewModel.ts` if view-model inputs still expect local Bridge polling labels
- Test: `app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts`

- [ ] **Step 1: Add failing static tests that forbid dormant Bridge hook routing**

Extend `app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts`:

```ts
test('main-cloud app model does not import or call local bridge state hooks', () => {
  const source = readSource('src/app/useKordiAppModel.ts');
  assert.doesNotMatch(source, /useBridgeState/);
  assert.doesNotMatch(source, /useBridgeOrchestration/);
  assert.doesNotMatch(source, /enabled:\s*kordiEdition\s*!==\s*'cloud'/);
  assert.doesNotMatch(source, /isCloudEdition:\s*kordiEdition\s*===\s*'cloud'/);
});
```

- [ ] **Step 2: Remove local Bridge hook imports and call sites**

In `app/desktop/src/app/useKordiAppModel.ts`, delete imports for:

```ts
import { useBridgeOrchestration } from '@/features/bridge/useBridgeOrchestration';
import { mergeDesktopBridgeState, useBridgeState } from '@/features/bridge/useBridgeState';
```

Delete the `useBridgeState(...)` call completely. Do not replace it with `enabled: false` or `kordiEdition !== 'cloud'`.

Delete `useBridgeOrchestration(...)` as a live Cloud path. If some shell props still need callbacks during the transition, create local no-op callbacks in `useKordiAppModel.ts` with names that make the removal explicit, for example:

```ts
const removedLocalBridgeAction = useCallback(async () => {
  throw new Error('Localhost Bridge communication was removed from main-cloud.');
}, []);
```

Use these no-op actions only to satisfy temporary UI prop types while Task 8 removes the UI entry points. Do not call any `desktop_bridge_*` Tauri command from them.

- [ ] **Step 3: Use Cloud state as the only collaboration host state**

Keep `useCloudBridgeState(...)` and assign its `mergedBridgeState` result to the existing `desktopBridgeState` variable only as a UI compatibility name:

```ts
const desktopBridgeState = cloudBridgeStateForUi;
```

Add a short comment:

```ts
// main-cloud keeps a Bridge-shaped UI adapter for existing components, but the
// data source is Cloud-native only. Do not merge localhost Bridge state here.
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudNoLegacyBridgeTransport.test.ts --test-name-pattern 'app model'
```

Expected: app model static tests pass and there are no `useBridgeState` or `useBridgeOrchestration` references in `useKordiAppModel.ts`.

- [ ] **Step 5: Commit Task 4**

```bash
git add app/desktop/src/app/useKordiAppModel.ts app/desktop/src/app/useKordiShellArgs.ts app/desktop/src/app/useKordiShellViewModel.ts app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts
git commit -m "refactor: remove local bridge app model path from main-cloud"
```

---

### Task 5: Delete old Bridge send/outreach branches from composer actions

**Files:**
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Modify: `app/desktop/src/features/chat/messageActions/projectMessages.ts`
- Modify: `app/desktop/src/features/chat/useComposerMessageActions.ts` only if old Bridge props become unused
- Test: `app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts`
- Test: `app/desktop/tests/cloudDirectContactSend.test.ts`
- Test: `app/desktop/tests/cloudGroupMessages.test.tsx`

- [ ] **Step 1: Add failing static tests forbidding composer Bridge communication**

Extend `app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts`:

```ts
test('main-cloud composer actions do not call old bridge communication commands', () => {
  for (const file of [
    'src/features/chat/messageActions/chatMessages.ts',
    'src/features/chat/messageActions/projectMessages.ts',
  ]) {
    const source = readSource(file);
    assert.doesNotMatch(source, /createDesktopBridgeOutreach/);
    assert.doesNotMatch(source, /sendDesktopBridgeMessage/);
    assert.doesNotMatch(source, /openDesktopBridgeConversation/);
    assert.doesNotMatch(source, /isCloudEdition/);
    assert.doesNotMatch(source, /nonCloudGroupTargets/);
  }
});
```

- [ ] **Step 2: Delete Bridge outreach imports and branches from chat messages**

In `app/desktop/src/features/chat/messageActions/chatMessages.ts`, remove imports for old Bridge communication:

```ts
createDesktopBridgeOutreach
openDesktopBridgeConversation
sendDesktopBridgeMessage
nonCloudGroupTargets
```

Delete branches whose only purpose is old Bridge E2E communication:

- `if (mentionedTarget && activeConversationUsesBridgeRouting) { ... createDesktopBridgeOutreach ... }`
- `sendPlan.shouldOpenBeforeOptimisticSend` branch using `openDesktopBridgeConversation`
- group `for (const target of groupSendTargets)` branch using `createDesktopBridgeOutreach`
- `shouldStayInCanonicalSession && activeConvBridgeTarget` branch using `createDesktopBridgeOutreach`
- fallback branch using `sendDesktopBridgeMessage`

Cloud group sends should call only `sendCloudGroupControl`. Cloud direct conversations should call only `sendCloudBridgeMessage`.

- [ ] **Step 3: Delete Bridge outreach imports and branches from project messages**

In `app/desktop/src/features/chat/messageActions/projectMessages.ts`, remove imports for:

```ts
mergeDesktopBridgeState
createDesktopBridgeOutreach
```

Delete the `mentionedTarget` Bridge outreach branch. Project sessions can still send local desktop chat messages via `startDesktopChatMessage`; they must not reach out through localhost Bridge.

- [ ] **Step 4: Remove unused types/props**

After deleting branches, run TypeScript and remove unused imports/arguments surfaced by the compiler. Do not add `isCloudEdition` or `enabled` props to composer types.

Run:

```bash
pnpm --dir app/desktop typecheck
```

Expected: either passes or reports only unused/removed-branch compile errors to clean up.

- [ ] **Step 5: Run targeted send tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudNoLegacyBridgeTransport.test.ts tests/cloudDirectContactSend.test.ts tests/cloudGroupMessages.test.tsx
```

Expected: tests pass; composer static test proves no old Bridge communication calls remain.

- [ ] **Step 6: Commit Task 5**

```bash
git add app/desktop/src/features/chat/messageActions/chatMessages.ts app/desktop/src/features/chat/messageActions/projectMessages.ts app/desktop/src/features/chat/useComposerMessageActions.ts app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts
git commit -m "refactor: delete localhost bridge composer transport"
```

---

### Task 6: Remove live desktop Bridge commands from the Cloud Tauri runtime

**Files:**
- Modify: `app/desktop/src-tauri/src/lib.rs`
- Modify: `app/desktop/src-tauri/src/bridge/mod.rs`
- Modify: `app/desktop/src-tauri/src/bridge/**` as needed
- Test: `app/desktop/src-tauri/src/bridge/tests.rs` or existing Rust tests

- [ ] **Step 1: Add failing static test for command registration removal**

Add a Rust or Node static test that reads `app/desktop/src-tauri/src/lib.rs` and asserts these command names are not registered in `tauri::generate_handler!` for `main-cloud`:

```text
desktop_bridge_state
desktop_bridge_send_message
desktop_bridge_create_outreach
desktop_bridge_poll_mailbox
desktop_bridge_refresh_realtime_connections
desktop_bridge_send_presence
desktop_bridge_start_local_server
desktop_bridge_stop_local_server
```

Use a source-text test if a Rust unit test cannot easily inspect macro registration.

- [ ] **Step 2: Remove automatic realtime scheduling**

In `app/desktop/src-tauri/src/lib.rs`, delete calls to:

```rust
bridge::schedule_bridge_realtime_refresh(app_handle, "app-resumed");
bridge::schedule_bridge_realtime_refresh(app_handle, "window-focused");
```

Do not wrap them in `if !cloud_edition_enabled()`.

- [ ] **Step 3: Remove live Bridge commands from `generate_handler!`**

Remove old localhost Bridge communication command registration from `tauri::generate_handler!`, including:

```rust
bridge::desktop_bridge_state,
bridge::desktop_bridge_start_local_server,
bridge::desktop_bridge_stop_local_server,
bridge::desktop_bridge_send_message,
bridge::desktop_bridge_create_outreach,
bridge::desktop_bridge_cancel_outreach,
bridge::desktop_bridge_send_presence,
bridge::desktop_bridge_poll_mailbox,
bridge::desktop_bridge_refresh_realtime_connections,
```

If config export/import commands are also only for old localhost Bridge UI, remove them in Task 8 with the UI controls.

- [ ] **Step 4: Remove now-unused Bridge runtime setup**

If `DesktopBridgeManager` is no longer used after command removal, remove:

```rust
.manage(DesktopBridgeManager::default())
bridge::set_bridge_app_handle(...)
```

If some type is still required by canonical historical read-model tests, keep it in Rust modules but do not register live commands or schedule realtime work.

- [ ] **Step 5: Run Rust verification**

Run:

```bash
cargo test -p kordi-desktop --no-default-features
```

Expected: Rust desktop tests pass with old Bridge live commands removed from Cloud runtime registration.

- [ ] **Step 6: Commit Task 6**

```bash
git add app/desktop/src-tauri/src/lib.rs app/desktop/src-tauri/src/bridge app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts
git commit -m "refactor: remove live bridge tauri commands from main-cloud"
```

---

### Task 7: Quarantine old `desktop-bridge-*` fixtures away from Cloud tests

**Files:**
- Modify: `app/desktop/tests/cloudBridgeState.test.tsx`
- Modify: `app/desktop/tests/cloudGroupMessages.test.tsx`
- Modify: `app/desktop/tests/cloudDirectContactSend.test.ts`
- Modify: `app/desktop/tests/chatRouting.test.tsx`
- Modify: `app/desktop/tests/canonicalBridgeRuntimeReadModel.test.tsx`
- Modify: `app/desktop/tests/canonicalBridgeVisibilityReadModel.test.tsx`

- [ ] **Step 1: Rename or move Cloud tests that use `desktop-bridge-*` fixtures**

For Cloud-specific tests, replace legacy fixture source transports:

```ts
sourceTransport: 'desktop-bridge-parent'
```

with Cloud-native fixture names:

```ts
sourceTransport: 'cloud-message-sync'
```

For Cloud group UI optimistic messages, use:

```ts
sourceTransport: 'cloud-group-ui'
```

For Cloud fork snapshots, use:

```ts
sourceTransport: 'cloud-group-fork-snapshot'
```

- [ ] **Step 2: Keep local Bridge read-model tests explicit**

At the top of local Bridge read-model test files, add this comment:

```ts
// These fixtures cover Local Edition desktop Bridge read-model compatibility.
// Cloud Edition must not use these source transports as live collaboration transport.
```

- [ ] **Step 3: Add static assertion for Cloud tests**

Extend `app/desktop/tests/cloudNoLegacyBridgeTransport.test.ts`:

```ts
test('cloud-specific tests do not use desktop bridge transport fixtures', () => {
  const cloudTestFiles = [
    'tests/cloudBridgeState.test.tsx',
    'tests/cloudGroupMessages.test.tsx',
    'tests/cloudDirectContactSend.test.ts',
    'tests/cloudContactRouting.test.tsx',
  ];
  for (const file of cloudTestFiles) {
    assert.doesNotMatch(readSource(file), /desktop-bridge-(parent|outreach|session-relay|ui)/, file);
  }
});
```

- [ ] **Step 4: Run test quarantine checks**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudNoLegacyBridgeTransport.test.ts tests/cloudBridgeState.test.tsx tests/cloudGroupMessages.test.tsx tests/cloudDirectContactSend.test.ts tests/cloudContactRouting.test.tsx
```

Expected: Cloud tests pass and static assertion finds no live `desktop-bridge-*` Cloud fixtures.

- [ ] **Step 5: Commit Task 7**

```bash
git add app/desktop/tests
git commit -m "test: quarantine legacy bridge fixtures from cloud tests"
```

---

### Task 8: Delete Cloud UI entry points for old Bridge communication controls

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Modify: `app/desktop/src/app/assembleRightDetailSlot.tsx`
- Modify: `app/desktop/src/app/kordiShellSlots.types.ts`
- Test: `app/desktop/tests/cloudEdition.test.tsx`
- Test: `app/desktop/tests/chatRouting.test.tsx`

- [ ] **Step 1: Add UI tests that old localhost Bridge actions are absent**

In `app/desktop/tests/cloudEdition.test.tsx`, add a test that renders/builds the Cloud shell and asserts old Bridge setup/actions are absent. Prefer DOM assertions if this file renders UI:

```ts
assert.equal(screen.queryByText(/Bridge setup|Start bridge|localhost bridge|Bridge config/i), null);
```

If the file uses model objects, assert:

```ts
assert.equal(model.bridgeWizardOpen, false);
assert.equal(model.bridgeInvite, null);
assert.equal(model.desktopBridgeState?.hosts.every((host) => host.id === 'cloud'), true);
assert.equal(model.shellActions.some((action) => /bridge|localhost/i.test(action.label)), false);
```

- [ ] **Step 2: Remove old Bridge controls instead of hiding them behind a flag**

Delete UI actions for:

- Bridge wizard button
- Bridge invite controls
- open Bridge config folder action
- reveal Bridge storage file action
- export/import Bridge hosts config actions
- start/stop local Bridge server actions

Do not add `showLocalBridgeControls = kordiEdition !== 'cloud'`. This branch is `main-cloud`; old localhost Bridge controls should not be part of the Cloud UI tree.

- [ ] **Step 3: Remove obsolete shell props**

If `kordiShellSlots.types.ts`, `useKordiShellArgs.ts`, or `assembleRightDetailSlot.tsx` require old Bridge handlers only for deleted UI controls, remove those props rather than passing no-op gated handlers.

- [ ] **Step 4: Run UI tests**

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/cloudEdition.test.tsx tests/chatRouting.test.tsx
```

Expected: Cloud Edition UI does not expose localhost Bridge controls; Cloud chat routing tests still pass.

- [ ] **Step 5: Commit Task 8**

```bash
git add app/desktop/src/pages/ChatsPage.tsx app/desktop/src/pages/WorkspaceSidebar.tsx app/desktop/src/app/assembleRightDetailSlot.tsx app/desktop/src/app/kordiShellSlots.types.ts app/desktop/src/app/useKordiShellArgs.ts app/desktop/tests/cloudEdition.test.tsx app/desktop/tests/chatRouting.test.tsx
git commit -m "refactor: delete localhost bridge controls from cloud ui"
```

---

### Task 9: Add production cleanup dry-run queries and documentation

**Files:**
- Create: `docs/cloud/cleanup/remove-localhost-kh-bridge-state-2026-05.md`
- Create: `bridges/cloud-server/scripts/dry-run-localhost-kh-cleanup.sql`

- [ ] **Step 1: Add dry-run SQL**

Create `bridges/cloud-server/scripts/dry-run-localhost-kh-cleanup.sql`:

```sql
-- Dry-run only. This file counts stale localhost/local Bridge artifacts that
-- should not be visible to Cloud Edition after issue #449.

WITH legacy_uuid_self AS (
  SELECT message_id
  FROM cloud_messages
  WHERE session_id !~ '^session:(direct-person|group|fork):'
    AND from_account_id = to_account_id
), possible_kh_group_controls AS (
  SELECT message_id
  FROM cloud_messages
  WHERE body LIKE 'kordi-cloud-group:%'
    AND body LIKE '%kh_%'
)
SELECT 'legacy_uuid_self_messages' AS check_name, count(*) AS row_count FROM legacy_uuid_self
UNION ALL
SELECT 'possible_kh_group_controls' AS check_name, count(*) AS row_count FROM possible_kh_group_controls;
```

- [ ] **Step 2: Add cleanup doc**

Create `docs/cloud/cleanup/remove-localhost-kh-bridge-state-2026-05.md`:

```md
# Remove localhost kh Bridge state from Cloud cleanup notes

This cleanup supports issue #449. It must run only after the Cloud client no longer reads localhost Bridge rows for Cloud collaboration.

## Dry run

```bash
kubectl -n kordi-cloud exec postgres-0 -- psql -U kordi -d kordi_cloud -P pager=off -f bridges/cloud-server/scripts/dry-run-localhost-kh-cleanup.sql
```

## Backup before delete

Use timestamped backup tables before deleting any rows:

```sql
CREATE TABLE incident_202605_issue449_legacy_messages AS
SELECT now() AS backed_up_at, m.*
FROM cloud_messages m
WHERE false;

CREATE TABLE incident_202605_issue449_legacy_sync_events AS
SELECT now() AS backed_up_at, e.*
FROM cloud_sync_events e
WHERE false;
```

## Delete policy

Delete only rows matching reviewed predicates and only after recording dry-run counts in the PR. Do not delete account records, refresh tokens, device keys, or Cloud session activity rows.
```

- [ ] **Step 3: Commit Task 9**

```bash
git add docs/cloud/cleanup/remove-localhost-kh-bridge-state-2026-05.md bridges/cloud-server/scripts/dry-run-localhost-kh-cleanup.sql
git commit -m "docs: add cloud localhost kh cleanup dry run"
```

---

### Task 10: Maintainability verification

**Files:**
- Modify if needed: files touched by earlier tasks
- Test: `scripts/report-overlong-files.mjs`

- [ ] **Step 1: Capture overlong-file baseline**

Run:

```bash
pnpm maintainability:scan -- --limit 20
```

Expected: command prints the current top overlong files. Copy the output into the PR notes.

- [ ] **Step 2: Check touched source files for line-count regressions**

Run:

```bash
git diff --name-only origin/main-cloud...HEAD \
  | rg '\\.(ts|tsx|rs)$' \
  | xargs wc -l
```

Expected: no touched source file is newly over 800 lines. If a touched file was already over 800 lines, its line count should be lower than the baseline from before the task, or the PR must include a focused extraction.

- [ ] **Step 3: Check for hard-coded Cloud/local IDs in source**

Run:

```bash
rg -n "acct_[a-zA-Z0-9]|kh_[a-zA-Z0-9]|session:group:|session:direct-person:|https://korde-product-cloud|127\\.0\\.0\\.1|localhost" \
  app/desktop/src app/desktop/src-tauri/src \
  --glob '!**/*.test.ts' \
  --glob '!**/*.test.tsx'
```

Expected: no new hard-coded account IDs, session IDs, `kh_*` values, or production Cloud URLs in source. Local model provider localhost references are allowed only in auth/provider modules such as Ollama/LM Studio.

- [ ] **Step 4: Check Cloud transport branching is contained**

Run:

```bash
rg -n "isCloudEdition|enabled:\s*kordiEdition|kordiEdition !== 'cloud'|desktop_bridge_(state|send_message|create_outreach|poll_mailbox|refresh_realtime_connections|send_presence)" \
  app/desktop/src app/desktop/src-tauri/src
```

Expected: no `isCloudEdition` or `enabled: kordiEdition` routing props were added, and old `desktop_bridge_*` communication references are absent from Cloud app source. Existing product-level Cloud auth/startup checks are acceptable only when unrelated to preserving old Bridge transport.

- [ ] **Step 5: Commit maintainability fixes**

If any maintainability issue is found, fix it and commit:

```bash
git add app/desktop/src app/desktop/src-tauri/src docs/superpowers/plans/2026-05-15-remove-localhost-kh-e2e-main-cloud.md
git commit -m "refactor: keep cloud transport cleanup maintainable"
```

If no code changes are needed, do not create an empty commit.

---

### Task 11: Full verification and issue update

**Files:**
- Modify if needed: `docs/cloud/cleanup/remove-localhost-kh-bridge-state-2026-05.md`
- Modify if needed: `docs/superpowers/plans/2026-05-15-remove-localhost-kh-e2e-main-cloud.md`

- [ ] **Step 1: Run frontend verification**

Run:

```bash
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop exec tsx --test \
  tests/cloudNoLegacyBridgeTransport.test.ts \
  tests/cloudBridgeState.test.tsx \
  tests/cloudGroupMessages.test.tsx \
  tests/cloudDirectContactSend.test.ts \
  tests/cloudContactRouting.test.tsx \
  tests/cloudEdition.test.tsx \
  tests/chatRouting.test.tsx
```

Expected: all selected frontend tests pass.

- [ ] **Step 2: Run Rust verification**

Run:

```bash
cargo test -p kordi-desktop --no-default-features
cargo test -p kordi-cloud-server --lib
```

Expected: both Rust test commands pass.

- [ ] **Step 3: Run static source check**

Run:

```bash
rg -n "desktop_bridge_(send_message|create_outreach|poll_mailbox|refresh_realtime_connections|send_presence)|kh_" app/desktop/src/features/cloud app/desktop/src/app app/desktop/src/features/chat/messageActions
```

Expected: no live Cloud transport references to old Bridge commands or `kh_`. References in local-only tests or docs are acceptable when labeled local-only.

- [ ] **Step 4: Manual Cloud QA**

Run this manual checklist:

```text
1. Start three clean Cloud instances.
2. Sign into three Cloud accounts.
3. Poison local Bridge storage with a kh_* identity and stale desktop-bridge-* conversations.
4. Confirm Cloud contacts show only acct_* Cloud identities.
5. Send a direct Cloud message.
6. Send a Cloud group message.
7. Mention another user's agent in a Cloud group.
8. Fork the Cloud group session.
9. Confirm tasks/artifacts hydrate through Cloud session activity.
10. Confirm no localhost Bridge host appears in UI and no desktop_bridge_* command is called for Cloud sends.
```

- [ ] **Step 5: Update issue #449**

Add a comment to issue #449 with:

```md
Implemented in PR #<number>.

Verification:
- `pnpm --dir app/desktop typecheck`
- `pnpm --dir app/desktop exec tsx --test ...`
- `cargo test -p kordi-desktop --no-default-features`
- `cargo test -p kordi-cloud-server --lib`

Cleanup notes:
- Dry-run SQL: `bridges/cloud-server/scripts/dry-run-localhost-kh-cleanup.sql`
- Cleanup doc: `docs/cloud/cleanup/remove-localhost-kh-bridge-state-2026-05.md`
```

- [ ] **Step 6: Commit final verification doc changes**

```bash
git add docs/cloud/cleanup/remove-localhost-kh-bridge-state-2026-05.md docs/superpowers/plans/2026-05-15-remove-localhost-kh-e2e-main-cloud.md
git commit -m "docs: finalize localhost kh cloud cleanup plan"
```

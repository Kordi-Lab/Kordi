# Safe Desktop Mention Handles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make desktop bridge mention handles safe, stable, and unambiguous across autocomplete and routing.

**Architecture:** Extract shared mention candidate construction into `messageActions/mentions.ts` so autocomplete and resolver use the same safe unique handles. Add tests for sanitization, collision suffixes, resolver behavior, and legacy display-label compatibility.

**Tech Stack:** React/TypeScript desktop app, Vite path aliases, Node test runner with `tsx` for focused TypeScript unit tests, existing `npm run typecheck` and `npm run lint` verification.

---

## File Structure

- Modify `app/desktop/package.json`: add a focused test script and `tsx` dev dependency.
- Modify `app/desktop/src/features/chat/messageActions/mentions.ts`: add shared safe unique candidate builder and update resolver/local mention helpers.
- Modify `app/desktop/src/app/useKordiAppModel.ts`: replace duplicated bridge mention option construction with shared builder.
- Create `app/desktop/src/features/chat/messageActions/mentions.test.ts`: unit tests for handle generation, uniqueness, resolver, display labels, and legacy matching.

---

### Task 1: Add focused tests for mention handles

**Files:**
- Modify: `app/desktop/package.json`
- Create: `app/desktop/src/features/chat/messageActions/mentions.test.ts`

- [ ] **Step 1: Add the test runner dependency and script**

Edit `app/desktop/package.json` so the scripts/devDependencies include:

```json
{
  "scripts": {
    "test:mentions": "tsx --test src/features/chat/messageActions/mentions.test.ts"
  },
  "devDependencies": {
    "tsx": "^4.20.6"
  }
}
```

Keep all existing scripts and dependencies; only add `test:mentions` and `tsx`.

- [ ] **Step 2: Write the failing tests**

Create `app/desktop/src/features/chat/messageActions/mentions.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBridgeMentionCandidates,
  localAgentMentionLabels,
  mentionHandleForLabel,
  outreachIdentityForBridgeTarget,
  resolveMentionedBridgeTarget,
} from './mentions';
import type { DesktopBridgeState, DesktopChatState } from '@/kordi-app/types';

function bridgeStateWithPeers(peers: DesktopBridgeState['hosts'][number]['visiblePeers']): DesktopBridgeState {
  return {
    activeHostId: 'host-1',
    hosts: [{
      id: 'host-1',
      displayName: 'Host One',
      ownerName: 'Host Owner',
      nodeId: 'host-node-1',
      humanId: 'host-human-1',
      inviteCode: null,
      inviteExpiresAt: null,
      configPath: null,
      activeAgentId: 'agent-local',
      agents: [{
        id: 'agent-local',
        nodeId: 'local-node-1',
        label: "Owner's Kordi",
        runtime: 'kordi-local',
        isDefault: true,
        isActive: true,
      }],
      visiblePeers: peers,
      conversations: [],
    }],
    activeConversationId: null,
    activeConversation: null,
    settings: {
      displayName: 'Host Owner',
      enableMdns: true,
      enableDerp: true,
      allowLanDiscovery: true,
      allowRelayFallback: true,
    },
  } as DesktopBridgeState;
}

test('mentionHandleForLabel keeps only unicode letters and numbers', () => {
  assert.equal(mentionHandleForLabel("Alice's Kordi"), 'AlicesKordi');
  assert.equal(mentionHandleForLabel('Ann Lee'), 'AnnLee');
  assert.equal(mentionHandleForLabel('開発 チーム 42'), '開発チーム42');
  assert.equal(mentionHandleForLabel('!!!', 'node-123'), 'node123');
});

test('buildBridgeMentionCandidates creates unique stable handles for sanitized collisions', () => {
  const bridgeState = bridgeStateWithPeers([
    {
      nodeId: 'node-alpha-111',
      displayName: 'Ann Lee',
      ownerName: 'Ann Lee',
      runtime: 'person',
      humanId: 'human-alpha-222',
      agentId: null,
      isDefaultAgent: false,
    },
    {
      nodeId: 'node-beta-333',
      displayName: 'Ann-Lee',
      ownerName: 'Ann-Lee',
      runtime: 'person',
      humanId: 'human-beta-444',
      agentId: null,
      isDefaultAgent: false,
    },
  ]);

  const annCandidates = buildBridgeMentionCandidates(bridgeState)
    .filter((candidate) => candidate.targetKind === 'bridge-person' && candidate.displayLabel.startsWith('Ann'));

  assert.equal(annCandidates.length, 2);
  assert.deepEqual(
    annCandidates.map((candidate) => candidate.handle).sort(),
    ['AnnLeehumanalp', 'AnnLeehumanbet'].sort(),
  );
});

test('resolveMentionedBridgeTarget uses the same unique handle as autocomplete candidates', () => {
  const bridgeState = bridgeStateWithPeers([
    {
      nodeId: 'node-alpha-111',
      displayName: 'Ann Lee',
      ownerName: 'Ann Lee',
      runtime: 'person',
      humanId: 'human-alpha-222',
      agentId: null,
      isDefaultAgent: false,
    },
    {
      nodeId: 'node-beta-333',
      displayName: 'Ann-Lee',
      ownerName: 'Ann-Lee',
      runtime: 'person',
      humanId: 'human-beta-444',
      agentId: null,
      isDefaultAgent: false,
    },
  ]);

  const target = resolveMentionedBridgeTarget('@AnnLeehumanbet please review', bridgeState);

  assert.equal(target?.peer.nodeId, 'node-beta-333');
  assert.equal(target?.label, 'AnnLeehumanbet');
  assert.equal(target?.displayLabel, 'Ann-Lee');
  assert.equal(target?.requestText, 'please review');
});

test('outreach identity preserves display label while mention metadata stores safe handle', () => {
  const bridgeState = bridgeStateWithPeers([
    {
      nodeId: 'node-kordi-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    },
  ]);

  const target = resolveMentionedBridgeTarget('@AlicesKordi summarize this', bridgeState);
  assert.ok(target);
  assert.equal(target.label, 'AlicesKordi');
  assert.equal(target.displayLabel, "Alice's Kordi");
  assert.equal(outreachIdentityForBridgeTarget(target).targetDisplayName, "Alice's Kordi");
});

test('legacy display-label matching works only when unambiguous', () => {
  const unambiguousState = bridgeStateWithPeers([
    {
      nodeId: 'node-alice-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-alice',
      agentId: 'agent-alice',
      isDefaultAgent: true,
    },
  ]);

  assert.equal(
    resolveMentionedBridgeTarget("@Alice's Kordi summarize", unambiguousState)?.peer.nodeId,
    'node-alice-1',
  );

  const ambiguousState = bridgeStateWithPeers([
    {
      nodeId: 'node-a-1',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-a',
      agentId: 'agent-a',
      isDefaultAgent: true,
    },
    {
      nodeId: 'node-a-2',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-local',
      humanId: 'human-b',
      agentId: 'agent-b',
      isDefaultAgent: true,
    },
  ]);

  assert.equal(resolveMentionedBridgeTarget("@Alice's Kordi summarize", ambiguousState), null);
});

test('local agent labels include sanitized aliases', () => {
  const chatState = {
    localAgent: {
      label: "Owner's Kordi",
      workspaceRoot: '/Users/example/My Project',
    },
  } as DesktopChatState;

  assert.deepEqual(
    localAgentMentionLabels(chatState, bridgeStateWithPeers([])),
    ['Kordi', 'OwnersKordi', 'HostOne', 'OwnersKordi', 'HostOwnersKordi', 'agentlocal', 'localnode1', 'MyProject'],
  );
});
```

- [ ] **Step 3: Run tests to verify they fail before implementation**

Run:

```bash
cd app/desktop
npm install
npm run test:mentions
```

Expected: tests fail because `buildBridgeMentionCandidates` does not exist and duplicate suffix behavior is not implemented.

- [ ] **Step 4: Commit the failing tests**

```bash
git add app/desktop/package.json app/desktop/package-lock.json app/desktop/src/features/chat/messageActions/mentions.test.ts
git commit -m "test: cover safe desktop mention handles"
```

---

### Task 2: Implement shared unique mention candidate generation

**Files:**
- Modify: `app/desktop/src/features/chat/messageActions/mentions.ts`
- Modify: `app/desktop/src/app/useKordiAppModel.ts`

- [ ] **Step 1: Add shared candidate types and helper functions**

In `app/desktop/src/features/chat/messageActions/mentions.ts`, replace `safeMentionCharacters`, `mentionHandleForLabel`, and the private candidate-building code inside `resolveMentionedBridgeTarget()` with these exported helpers:

```ts
export type BridgeMentionCandidate = {
  host: DesktopBridgeState['hosts'][number];
  peer: DesktopBridgeState['hosts'][number]['visiblePeers'][number];
  handle: string;
  normalizedHandle: string;
  displayLabel: string;
  targetKind: 'bridge-person' | 'bridge-agent';
};

function safeMentionCharacters(value: string) {
  return value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.join('') ?? '';
}

export function mentionHandleForLabel(value: string, fallback = 'Participant') {
  const handle = safeMentionCharacters(value) || safeMentionCharacters(fallback) || 'Participant';
  return handle.slice(0, 64);
}

function identitySuffixForCandidate(candidate: Pick<BridgeMentionCandidate, 'peer' | 'handle'>) {
  const source = candidate.peer.humanId?.trim()
    || candidate.peer.agentId?.trim()
    || candidate.peer.nodeId?.trim()
    || candidate.handle;
  return safeMentionCharacters(source).slice(0, 8) || 'target';
}

function uniqueHandle(baseHandle: string, suffix: string) {
  const cleanSuffix = safeMentionCharacters(suffix) || 'target';
  const availableBaseLength = Math.max(1, 64 - cleanSuffix.length);
  return `${baseHandle.slice(0, availableBaseLength)}${cleanSuffix}`;
}

export function buildBridgeMentionCandidates(bridgeState: DesktopBridgeState | null) {
  if (!bridgeState) return [];

  const rawCandidates: BridgeMentionCandidate[] = [];

  for (const host of bridgeState.hosts) {
    for (const peer of host.visiblePeers) {
      const isAgent = isBridgeAgentRuntime(peer.runtime);
      const seenForPeer = new Set<string>();
      const pushLabel = (value: string | null | undefined, targetKind: BridgeMentionCandidate['targetKind']) => {
        const displayLabel = value?.trim();
        if (!displayLabel) return;
        const handle = mentionHandleForLabel(displayLabel, peer.nodeId);
        const dedupeKey = `${targetKind}:${normalizeMentionLabel(handle)}:${normalizeMentionLabel(displayLabel)}`;
        if (seenForPeer.has(dedupeKey)) return;
        seenForPeer.add(dedupeKey);
        rawCandidates.push({
          host,
          peer,
          targetKind,
          displayLabel,
          handle,
          normalizedHandle: normalizeMentionLabel(handle),
        });
      };

      if (isAgent && peer.humanId?.trim()) {
        pushLabel(peer.ownerName, 'bridge-person');
      }
      pushLabel(peer.displayName, isAgent ? 'bridge-agent' : 'bridge-person');
      if (!isAgent) {
        pushLabel(peer.ownerName, 'bridge-person');
      }
      pushLabel(peer.nodeId, isAgent ? 'bridge-agent' : 'bridge-person');
    }
  }

  const handleCounts = new Map<string, number>();
  for (const candidate of rawCandidates) {
    handleCounts.set(candidate.normalizedHandle, (handleCounts.get(candidate.normalizedHandle) ?? 0) + 1);
  }

  const usedHandles = new Set<string>();
  return rawCandidates.map((candidate) => {
    let handle = candidate.handle;
    if ((handleCounts.get(candidate.normalizedHandle) ?? 0) > 1) {
      handle = uniqueHandle(candidate.handle, identitySuffixForCandidate(candidate));
    }
    let normalizedHandle = normalizeMentionLabel(handle);
    let collisionIndex = 2;
    while (usedHandles.has(normalizedHandle)) {
      handle = uniqueHandle(candidate.handle, `${identitySuffixForCandidate(candidate)}${collisionIndex}`);
      normalizedHandle = normalizeMentionLabel(handle);
      collisionIndex += 1;
    }
    usedHandles.add(normalizedHandle);
    return { ...candidate, handle, normalizedHandle };
  });
}
```

- [ ] **Step 2: Update local mention labels to use safe handles without accidental duplicates**

Keep `localAgentMentionLabels()` returning sanitized handles, but use the existing `Array.from(new Set(...))` behavior. No code change is required if Task 1's helper definitions are in place.

- [ ] **Step 3: Update resolver to consume shared candidates and support unambiguous legacy labels**

Replace `resolveMentionedBridgeTarget()` with:

```ts
export function resolveMentionedBridgeTarget(text: string, bridgeState: DesktopBridgeState | null) {
  const candidates = buildBridgeMentionCandidates(bridgeState);
  if (candidates.length === 0) return null;
  const mentionMatches = Array.from(text.matchAll(/(^|\s)@/g));
  if (mentionMatches.length === 0) return null;

  for (const mention of mentionMatches) {
    const mentionStart = (mention.index ?? 0) + mention[1].length;
    const rawAfterAt = text.slice(mentionStart + 1);
    const leadingWhitespace = rawAfterAt.length - rawAfterAt.trimStart().length;
    const afterAt = rawAfterAt.trimStart();
    if (!afterAt) continue;

    const safeMatches = candidates
      .filter((candidate) => mentionTextStartsWithLabel(afterAt, candidate.handle))
      .sort((left, right) => right.normalizedHandle.length - left.normalizedHandle.length);

    const legacyMatches = safeMatches.length > 0
      ? []
      : candidates
        .filter((candidate) => mentionTextStartsWithLabel(afterAt, candidate.displayLabel));

    const legacyNormalizedKeys = new Set(legacyMatches.map((candidate) => `${candidate.targetKind}:${candidate.host.id}:${candidate.peer.nodeId}`));
    const match = safeMatches[0] ?? (legacyNormalizedKeys.size === 1 ? legacyMatches[0] : null);
    if (!match) continue;

    const matchedLabel = safeMatches.length > 0 ? match.handle : match.displayLabel;
    let mentionEnd = mentionStart + 1 + leadingWhitespace + matchedLabel.length;
    if (/[:;,.!?—-]/.test(text[mentionEnd] ?? '')) {
      mentionEnd += 1;
    }
    const requestText = `${text.slice(0, mentionStart)}${text.slice(mentionEnd)}`.replace(/\s+/g, ' ').trim();
    if (!requestText) continue;

    return {
      host: match.host,
      peer: match.peer,
      label: match.handle,
      displayLabel: match.displayLabel,
      targetKind: match.targetKind,
      requestText,
    };
  }

  return null;
}
```

- [ ] **Step 4: Replace duplicated autocomplete option construction**

In `app/desktop/src/app/useKordiAppModel.ts`, import `buildBridgeMentionCandidates` next to `mentionHandleForLabel`:

```ts
import { buildBridgeMentionCandidates, mentionHandleForLabel } from '@/features/chat/messageActions/mentions';
```

Then replace the peer loop inside `bridgeMentionTargets` with:

```ts
    for (const candidate of buildBridgeMentionCandidates(desktopBridgeState)) {
      pushOption({
        value: candidate.handle,
        label: candidate.handle,
        detail: [
          candidate.targetKind === 'bridge-agent' ? 'Bridge agent' : 'Bridge person',
          candidate.displayLabel !== candidate.handle ? candidate.displayLabel : null,
          candidate.peer.ownerName?.trim() && candidate.peer.ownerName?.trim() !== candidate.displayLabel ? candidate.peer.ownerName?.trim() : null,
          candidate.host.displayName || candidate.host.ownerName,
          candidate.peer.runtime,
        ].filter((value): value is string => Boolean(value)).join(' • '),
        targetKind: candidate.targetKind,
        bridgeHostId: candidate.host.id,
        nodeId: candidate.peer.nodeId,
        runtime: candidate.targetKind === 'bridge-person' ? 'person' : candidate.peer.runtime,
      });
    }
```

Keep the existing local-agent option block above the loop.

- [ ] **Step 5: Run focused tests**

Run:

```bash
cd app/desktop
npm run test:mentions
```

Expected: all mention tests pass.

- [ ] **Step 6: Commit implementation**

```bash
git add app/desktop/src/features/chat/messageActions/mentions.ts app/desktop/src/app/useKordiAppModel.ts
git commit -m "fix: share unique safe mention handles"
```

---

### Task 3: Final verification and review fixes

**Files:**
- Modify only if verification identifies issues.

- [ ] **Step 1: Run full desktop verification**

Run:

```bash
cd app/desktop
npm run test:mentions
npm run typecheck
npm run lint
```

Expected: all commands exit successfully.

- [ ] **Step 2: Inspect diff for unwanted scope expansion**

Run:

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- app/desktop/src/features/chat/messageActions/mentions.ts app/desktop/src/app/useKordiAppModel.ts app/desktop/src/features/chat/messageActions/mentions.test.ts app/desktop/package.json
```

Expected: changes are limited to safe unique mention handling, focused tests, and package test setup.

- [ ] **Step 3: Fix any verification failures with minimal changes**

If `test:mentions`, `typecheck`, or `lint` fails, fix only the failing issue and rerun:

```bash
cd app/desktop
npm run test:mentions
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 4: Commit verification fixes if needed**

If Step 3 changed files:

```bash
git add app/desktop
git commit -m "fix: satisfy mention handle verification"
```

- [ ] **Step 5: Prepare final summary**

Report:

```text
Implemented shared unique safe mention handles.
Verification:
- npm run test:mentions
- npm run typecheck
- npm run lint

Key behavior:
- autocomplete and resolver use same handles
- duplicate sanitized handles get stable identity suffixes
- outreach display names remain human-readable
- unambiguous legacy display-label mentions still resolve
```

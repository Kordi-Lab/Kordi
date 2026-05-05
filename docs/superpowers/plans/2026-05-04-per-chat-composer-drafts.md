# Per-Chat Composer Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #213 — make the chat input box a per-session draft so switching chats no longer leaks unsent text from one chat into another, and persist drafts across reloads.

**Architecture:** Replace the global `Record<ComposerScope, string>` state with `Record<ComposerScope, Record<sessionId, ComposerDraftEntry>>` keyed by chat/project session id. A pure helper module owns the data shape, mutation helper, and localStorage persistence with TTL + size cap. `useKordiAppModel` projects the per-session map down to the existing `Record<ComposerScope, string>` shape that read consumers already expect, so the API surface for read sites is unchanged. Write sites update via a single `updateScopeDraft(state, scope, sessionId, value)` helper that handles the empty-string-deletes-key invariant.

**Tech Stack:** TypeScript, React 19, Vite, Node.js test runner (`tsx --test tests/*.test.tsx`), `node:assert/strict`. localStorage for persistence (mirroring the pattern in `composerAttachments.ts`).

**Spec:** `docs/superpowers/specs/2026-05-04-per-chat-composer-drafts-design.md`

**Working directory:** `/Users/shuyang/kordi-worktrees/issue-213-per-chat-composer-drafts`. All shell paths below assume this is the cwd. The desktop app lives at `app/desktop/`; run pnpm commands from there.

---

## File Map

**New files**

- `app/desktop/src/features/chat/composerDrafts.ts` — types (`ComposerDraftEntry`, `ComposerDraftState`), `EMPTY_COMPOSER_DRAFT_STATE`, `updateScopeDraft`, `parseStoredComposerDrafts`, `serializeStoredComposerDrafts`, `readStoredComposerDrafts`, `writeStoredComposerDrafts`, TTL + cap pruning constants and helpers.
- `app/desktop/tests/composerDrafts.test.tsx` — unit tests for every export of the new module.
- `app/desktop/tests/composerDraftsBehavior.test.tsx` — integration test for switching/sending/reload behavior using a focused harness around `useKordiLocalUiState` plus a stub session selector.

**Modified files**

- `app/desktop/src/app/useKordiLocalUiState.ts` — replace `composerDrafts` state shape, lazy-init from storage, debounced write effect.
- `app/desktop/src/features/chat/composerController.types.ts` — change `ComposerDraftState` to the new map shape; add `activeConvId` / `activeProjectSessionId` to args (already present, no change needed — just verified).
- `app/desktop/src/app/useKordiAppModel.ts` — derive `composerDraftsView: Record<ComposerScope, string>` from the raw state for read consumers; plumb session ids to write consumers; prune entries on chat session deletion.
- `app/desktop/src/features/chat/useComposerInputActions.ts` — typing handlers (`setChatComposerText`, `setProjectComposerText`) call `updateScopeDraft` and add active session ids to deps.
- `app/desktop/src/features/chat/useComposerMessageActions.ts` — mention-insertion callbacks call `updateScopeDraft` and add session ids to deps.
- `app/desktop/src/features/chat/messageActions/chatMessages.ts` — six `setComposerDrafts((c) => ({ ...c, chat: '' }))` clear sites become `updateScopeDraft(...)` calls keyed by the just-sent session id.
- `app/desktop/src/features/chat/useDesktopSessionController.ts` — has an inline `Dispatch<SetStateAction<Record<'chat' | 'project', string>>>` type on the prop (line 57) and a `setComposerDrafts((current) => ({ ...current, chat: '' }))` clear in `handleCreateChatSession` (line 122). Both must be updated to the new shape.

**Verified-no-change files**

- `app/desktop/src/features/chat/messageActions/projectMessages.ts` — already clears via `appendProjectDraft('')`, which is `setProjectComposerText('')`. Once the typing handler in `useComposerInputActions.ts` is updated, project clears flow through that handler and need no direct edit here.
- `app/desktop/src/features/chat/useComposerViewModel.ts` — consumes `composerDrafts.chat` / `.project` as strings (the projected view). No change.

---

## Task 1: Pure helper module — types and `updateScopeDraft`

**Files:**
- Create: `app/desktop/src/features/chat/composerDrafts.ts`
- Test: `app/desktop/tests/composerDrafts.test.tsx`

- [ ] **Step 1: Create the helper file with types and `updateScopeDraft`**

Write `app/desktop/src/features/chat/composerDrafts.ts`:

```ts
import type { ComposerScope } from '@/kordi-app/types';

export type ComposerDraftEntry = { text: string; updatedAt: number };
export type ComposerDraftState = {
  chat:    Record<string, ComposerDraftEntry>;
  project: Record<string, ComposerDraftEntry>;
};

export const EMPTY_COMPOSER_DRAFT_STATE: ComposerDraftState = { chat: {}, project: {} };

export function updateScopeDraft(
  state: ComposerDraftState,
  scope: ComposerScope,
  sessionId: string,
  value: string,
  now: number = Date.now(),
): ComposerDraftState {
  if (!sessionId) return state;
  const scopeMap = state[scope];
  if (value === '') {
    if (!(sessionId in scopeMap)) return state;
    const nextScope = { ...scopeMap };
    delete nextScope[sessionId];
    return { ...state, [scope]: nextScope };
  }
  const existing = scopeMap[sessionId];
  if (existing && existing.text === value) return state;
  return {
    ...state,
    [scope]: {
      ...scopeMap,
      [sessionId]: { text: value, updatedAt: now },
    },
  };
}
```

- [ ] **Step 2: Write unit tests for `updateScopeDraft`**

Write `app/desktop/tests/composerDrafts.test.tsx`:

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_COMPOSER_DRAFT_STATE,
  updateScopeDraft,
} from '../src/features/chat/composerDrafts';

test('updateScopeDraft inserts a new entry with text and timestamp', () => {
  const next = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'hello', 1000);
  assert.deepEqual(next.chat['session-a'], { text: 'hello', updatedAt: 1000 });
  assert.deepEqual(next.project, {});
});

test('updateScopeDraft updates an existing entry and bumps the timestamp', () => {
  const seeded = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'hello', 1000);
  const next = updateScopeDraft(seeded, 'chat', 'session-a', 'hello world', 2000);
  assert.deepEqual(next.chat['session-a'], { text: 'hello world', updatedAt: 2000 });
});

test('updateScopeDraft is a no-op when the value did not change', () => {
  const seeded = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'hello', 1000);
  const next = updateScopeDraft(seeded, 'chat', 'session-a', 'hello', 9999);
  assert.equal(next, seeded);
});

test('updateScopeDraft deletes the entry when the value is empty', () => {
  const seeded = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'hello', 1000);
  const next = updateScopeDraft(seeded, 'chat', 'session-a', '', 2000);
  assert.equal('session-a' in next.chat, false);
});

test('updateScopeDraft empty-on-missing is a no-op (returns same reference)', () => {
  const next = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', '', 1000);
  assert.equal(next, EMPTY_COMPOSER_DRAFT_STATE);
});

test('updateScopeDraft scopes are independent', () => {
  const seeded = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-a', 'chat-text', 1000);
  const next = updateScopeDraft(seeded, 'project', 'session-a', 'project-text', 2000);
  assert.deepEqual(next.chat['session-a'], { text: 'chat-text', updatedAt: 1000 });
  assert.deepEqual(next.project['session-a'], { text: 'project-text', updatedAt: 2000 });
});

test('updateScopeDraft ignores empty session ids', () => {
  const next = updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', '', 'hello', 1000);
  assert.equal(next, EMPTY_COMPOSER_DRAFT_STATE);
});
```

- [ ] **Step 3: Run the tests and verify they pass**

Run: `cd app/desktop && pnpm test:unit -- tests/composerDrafts.test.tsx`
Expected: 7 passing tests, 0 failing.

- [ ] **Step 4: Commit**

```bash
git add app/desktop/src/features/chat/composerDrafts.ts app/desktop/tests/composerDrafts.test.tsx
git commit -m "Add ComposerDraftState type and updateScopeDraft helper (#213)"
```

---

## Task 2: Pure helper module — parse and serialize

**Files:**
- Modify: `app/desktop/src/features/chat/composerDrafts.ts`
- Test: `app/desktop/tests/composerDrafts.test.tsx`

- [ ] **Step 1: Add additional failing tests for parse/serialize**

Append to `app/desktop/tests/composerDrafts.test.tsx`:

```tsx
import {
  parseStoredComposerDrafts,
  serializeStoredComposerDrafts,
} from '../src/features/chat/composerDrafts';

test('parseStoredComposerDrafts returns the empty state for invalid input', () => {
  for (const raw of [null, undefined, '', 'not json', '[]', '{"chat": "wrong"}']) {
    assert.deepEqual(parseStoredComposerDrafts(raw), { chat: {}, project: {} });
  }
});

test('parseStoredComposerDrafts drops malformed entries but keeps valid ones', () => {
  const raw = JSON.stringify({
    chat: {
      good:  { text: 'ok', updatedAt: 1000 },
      blank: { text: '', updatedAt: 1000 },
      bad1:  { text: 42, updatedAt: 1000 },
      bad2:  { text: 'ok', updatedAt: 'soon' },
      bad3:  { text: 'ok', updatedAt: Number.NaN },
    },
    project: {},
  });
  const parsed = parseStoredComposerDrafts(raw);
  assert.deepEqual(parsed.chat, { good: { text: 'ok', updatedAt: 1000 } });
  assert.deepEqual(parsed.project, {});
});

test('serializeStoredComposerDrafts round-trips a valid state', () => {
  const state = {
    chat:    { 'session-a': { text: 'hello', updatedAt: 1000 } },
    project: { 'session-b': { text: 'world', updatedAt: 2000 } },
  };
  const json = serializeStoredComposerDrafts(state);
  assert.deepEqual(parseStoredComposerDrafts(json), state);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd app/desktop && pnpm test:unit -- tests/composerDrafts.test.tsx`
Expected: failures because `parseStoredComposerDrafts` and `serializeStoredComposerDrafts` are not yet exported.

- [ ] **Step 3: Implement parse and serialize**

Append to `app/desktop/src/features/chat/composerDrafts.ts`:

```ts
function entryFromRecord(value: unknown): ComposerDraftEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = record.text;
  const updatedAt = record.updatedAt;
  if (typeof text !== 'string' || text.length === 0) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  return { text, updatedAt };
}

function scopeFromRecord(value: unknown): Record<string, ComposerDraftEntry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, ComposerDraftEntry> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = entryFromRecord(raw);
    if (entry) out[key] = entry;
  }
  return out;
}

export function parseStoredComposerDrafts(raw: string | null | undefined): ComposerDraftState {
  if (!raw) return { chat: {}, project: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { chat: {}, project: {} };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { chat: {}, project: {} };
  const record = value as Record<string, unknown>;
  return {
    chat:    scopeFromRecord(record.chat),
    project: scopeFromRecord(record.project),
  };
}

export function serializeStoredComposerDrafts(state: ComposerDraftState): string {
  return JSON.stringify(state);
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd app/desktop && pnpm test:unit -- tests/composerDrafts.test.tsx`
Expected: all tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/chat/composerDrafts.ts app/desktop/tests/composerDrafts.test.tsx
git commit -m "Add parse/serialize helpers for stored composer drafts (#213)"
```

---

## Task 3: Pure helper module — read/write with TTL and cap pruning

**Files:**
- Modify: `app/desktop/src/features/chat/composerDrafts.ts`
- Test: `app/desktop/tests/composerDrafts.test.tsx`

- [ ] **Step 1: Add failing tests for storage I/O with prune**

Append to `app/desktop/tests/composerDrafts.test.tsx`:

```tsx
import {
  COMPOSER_DRAFTS_STORAGE_KEY,
  COMPOSER_DRAFT_TTL_MS,
  COMPOSER_DRAFT_SCOPE_CAP,
  readStoredComposerDrafts,
  writeStoredComposerDrafts,
} from '../src/features/chat/composerDrafts';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem:    (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem:    (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

test('readStoredComposerDrafts drops entries older than the TTL', () => {
  const now = 1_700_000_000_000;
  const fresh = now - 1000;
  const stale = now - COMPOSER_DRAFT_TTL_MS - 1;
  const storage = fakeStorage({
    [COMPOSER_DRAFTS_STORAGE_KEY]: JSON.stringify({
      chat: {
        fresh: { text: 'fresh', updatedAt: fresh },
        stale: { text: 'stale', updatedAt: stale },
      },
      project: {},
    }),
  });
  const result = readStoredComposerDrafts(storage, now);
  assert.deepEqual(Object.keys(result.chat), ['fresh']);
});

test('readStoredComposerDrafts caps each scope to COMPOSER_DRAFT_SCOPE_CAP, keeping the most recent', () => {
  const now = 1_700_000_000_000;
  const overflow = COMPOSER_DRAFT_SCOPE_CAP + 50;
  const chat: Record<string, { text: string; updatedAt: number }> = {};
  for (let i = 0; i < overflow; i++) {
    chat[`session-${i}`] = { text: `text ${i}`, updatedAt: now - (overflow - i) };
  }
  const storage = fakeStorage({
    [COMPOSER_DRAFTS_STORAGE_KEY]: JSON.stringify({ chat, project: {} }),
  });
  const result = readStoredComposerDrafts(storage, now);
  assert.equal(Object.keys(result.chat).length, COMPOSER_DRAFT_SCOPE_CAP);
  assert.equal(`session-${overflow - 1}` in result.chat, true);
  assert.equal(`session-0` in result.chat, false);
});

test('writeStoredComposerDrafts removes the storage key when both scopes are empty', () => {
  const storage = fakeStorage({ [COMPOSER_DRAFTS_STORAGE_KEY]: 'leftover' });
  writeStoredComposerDrafts({ chat: {}, project: {} }, storage);
  assert.equal(storage.data.has(COMPOSER_DRAFTS_STORAGE_KEY), false);
});

test('writeStoredComposerDrafts persists a non-empty state', () => {
  const storage = fakeStorage();
  writeStoredComposerDrafts(
    { chat: { 'session-a': { text: 'hi', updatedAt: 1000 } }, project: {} },
    storage,
  );
  const json = storage.data.get(COMPOSER_DRAFTS_STORAGE_KEY);
  assert.ok(json, 'expected storage to contain the key');
  assert.deepEqual(JSON.parse(json), {
    chat:    { 'session-a': { text: 'hi', updatedAt: 1000 } },
    project: {},
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd app/desktop && pnpm test:unit -- tests/composerDrafts.test.tsx`
Expected: failures because the new exports don't exist yet.

- [ ] **Step 3: Implement read/write/prune**

Append to `app/desktop/src/features/chat/composerDrafts.ts`:

```ts
export const COMPOSER_DRAFTS_STORAGE_KEY = 'kordi.composerDrafts.v1';
export const COMPOSER_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const COMPOSER_DRAFT_SCOPE_CAP = 200;

type ComposerDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): ComposerDraftStorage | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function pruneScope(scope: Record<string, ComposerDraftEntry>, now: number): Record<string, ComposerDraftEntry> {
  const cutoff = now - COMPOSER_DRAFT_TTL_MS;
  const fresh = Object.entries(scope).filter(([, entry]) => entry.updatedAt >= cutoff);
  if (fresh.length <= COMPOSER_DRAFT_SCOPE_CAP) {
    return Object.fromEntries(fresh);
  }
  fresh.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(fresh.slice(0, COMPOSER_DRAFT_SCOPE_CAP));
}

export function readStoredComposerDrafts(
  storage: ComposerDraftStorage | null = browserStorage(),
  now: number = Date.now(),
): ComposerDraftState {
  if (!storage) return { chat: {}, project: {} };
  const parsed = parseStoredComposerDrafts(storage.getItem(COMPOSER_DRAFTS_STORAGE_KEY));
  return {
    chat:    pruneScope(parsed.chat, now),
    project: pruneScope(parsed.project, now),
  };
}

export function writeStoredComposerDrafts(
  state: ComposerDraftState,
  storage: ComposerDraftStorage | null = browserStorage(),
) {
  if (!storage) return;
  const isEmpty = Object.keys(state.chat).length === 0 && Object.keys(state.project).length === 0;
  if (isEmpty) {
    storage.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
    return;
  }
  storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, serializeStoredComposerDrafts(state));
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd app/desktop && pnpm test:unit -- tests/composerDrafts.test.tsx`
Expected: all tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/features/chat/composerDrafts.ts app/desktop/tests/composerDrafts.test.tsx
git commit -m "Add localStorage read/write helpers with TTL and cap pruning (#213)"
```

---

## Task 4: Update `ComposerDraftState` type and prepare consumer types

**Files:**
- Modify: `app/desktop/src/features/chat/composerController.types.ts`

This task only changes the exported type. After this task, the project will not typecheck — Tasks 5–9 fix all consumers. Do not run `pnpm typecheck` until Task 9 is complete.

- [ ] **Step 1: Replace the legacy type definition**

In `app/desktop/src/features/chat/composerController.types.ts:22`, find:

```ts
export type ComposerDraftState = Record<ComposerScope, string>;
```

Replace with an import + alias:

```ts
export type { ComposerDraftEntry, ComposerDraftState } from './composerDrafts';
```

(Remove the old line. The `ComposerScope` import previously used by this declaration may still be needed by other code in this file — leave the rest of the file alone.)

- [ ] **Step 2: Verify file still parses**

Run: `cd app/desktop && pnpm exec tsc --noEmit src/features/chat/composerController.types.ts 2>&1 | head -5`
Expected: errors about consumers (not about this file itself).

- [ ] **Step 3: Do NOT commit yet**

This change is part of the lockstep migration in Tasks 5–9. Leave it staged but uncommitted until Task 9 completes.

---

## Task 5: Migrate `useKordiLocalUiState` state shape and persistence

**Files:**
- Modify: `app/desktop/src/app/useKordiLocalUiState.ts`

- [ ] **Step 1: Update imports**

At the top of `app/desktop/src/app/useKordiLocalUiState.ts`, replace the existing import block for `ComposerScope`/`ComposerSelectorType` with the same plus the new module:

```ts
import { readStoredComposerAttachments, writeStoredComposerAttachments } from '@/features/chat/composerAttachments';
import {
  EMPTY_COMPOSER_DRAFT_STATE,
  readStoredComposerDrafts,
  writeStoredComposerDrafts,
  type ComposerDraftState,
} from '@/features/chat/composerDrafts';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { contactRequests, projects, settingsSections } from '@/kordi-app/data';
import type { ChatFilter, ComposerScope, ComposerSelectorType, ContactClass, EditFilePreview, ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';
```

- [ ] **Step 2: Replace the `composerDrafts` `useState` call**

Find lines 63–66:

```ts
const [composerDrafts, setComposerDrafts] = useState<Record<ComposerScope, string>>({
  chat: '',
  project: '',
});
```

Replace with:

```ts
const [composerDrafts, setComposerDrafts] = useState<ComposerDraftState>(
  () => readStoredComposerDrafts(),
);
```

(The variable names stay the same so the rest of the file's bookkeeping works untouched.)

- [ ] **Step 3: Add a debounced persistence effect**

Immediately after the new `useState` call, insert:

```ts
useEffect(() => {
  const handle = setTimeout(() => {
    writeStoredComposerDrafts(composerDrafts);
  }, 300);
  return () => clearTimeout(handle);
}, [composerDrafts]);
```

(`useEffect` is already imported at the top of the file.)

The trailing-edge debounce flushes 300 ms after the last change and on unmount cleanup, the timer is cleared so an in-flight write is cancelled — the next mount will re-read the latest state from the previous flushed write.

- [ ] **Step 4: Confirm the returned `composerUi` block needs no changes**

The returned `composerUi: { composerDrafts, setComposerDrafts, ... }` keeps the same names. Read consumers will be migrated to a derived view in Task 7; write consumers will be migrated in Tasks 6, 8, and 9. No edit needed here.

- [ ] **Step 5: Stage but do not commit**

```bash
git add app/desktop/src/app/useKordiLocalUiState.ts
```

---

## Task 6: Migrate typing handlers in `useComposerInputActions`

**Files:**
- Modify: `app/desktop/src/features/chat/useComposerInputActions.ts`

- [ ] **Step 1: Add the helper import**

At the top of the file, alongside the existing `composerAttachments` import, add:

```ts
import { updateScopeDraft } from './composerDrafts';
```

- [ ] **Step 2: Replace `setChatComposerText`**

At line ~410, find:

```ts
const setChatComposerText = useCallback((value: string) => {
  setComposerDrafts((current: ComposerDraftState) => ({ ...current, chat: value }));
  resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]', value);
}, [setComposerDrafts]);
```

Replace with:

```ts
const setChatComposerText = useCallback((value: string) => {
  setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'chat', activeConvId, value));
  resizeComposerTextarea('textarea[placeholder="Message a person, an agent, or delegate a task…"]', value);
}, [activeConvId, setComposerDrafts]);
```

- [ ] **Step 3: Replace `setProjectComposerText`**

Immediately after, find:

```ts
const setProjectComposerText = useCallback((value: string) => {
  setComposerDrafts((current: ComposerDraftState) => ({ ...current, project: value }));
  resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]', value);
}, [setComposerDrafts]);
```

Replace with:

```ts
const setProjectComposerText = useCallback((value: string) => {
  setComposerDrafts((current: ComposerDraftState) => updateScopeDraft(current, 'project', activeProjectSessionId, value));
  resizeComposerTextarea('textarea[placeholder="Post to this project session, ask a member, or start a new topic…"]', value);
}, [activeProjectSessionId, setComposerDrafts]);
```

- [ ] **Step 4: Stage but do not commit**

```bash
git add app/desktop/src/features/chat/useComposerInputActions.ts
```

---

## Task 7: Project a derived view + migrate read/write sites in `useKordiAppModel`

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`

- [ ] **Step 1: Add helper imports**

At the top of `app/desktop/src/app/useKordiAppModel.ts`, alongside the existing `@/features/chat/...` imports, add:

```ts
import { updateScopeDraft } from '@/features/chat/composerDrafts';
```

- [ ] **Step 2: Derive the read view**

Find the block right after `composerUi.composerDrafts` is first read (currently used at line 221 — `composerDrafts: composerUi.composerDrafts`). Above the first place `composerUi.composerDrafts` is referenced, add:

```ts
const composerDraftsView = useMemo<Record<ComposerScope, string>>(() => ({
  chat:    composerUi.composerDrafts.chat[activeConvId]?.text                ?? '',
  project: composerUi.composerDrafts.project[activeProjectSessionId]?.text   ?? '',
}), [composerUi.composerDrafts, activeConvId, activeProjectSessionId]);
```

The chat scope is keyed by `activeConvId` and the project scope by `activeProjectSessionId` — these are the same ids the typing handlers in Task 6 use, so reads and writes line up. `useMemo` is already imported. `ComposerScope` is already imported (it's used by other code in this file). If not, add `import type { ComposerScope } from '@/kordi-app/types';`.

- [ ] **Step 3: Replace every read of `composerUi.composerDrafts.chat` / `.project` with `composerDraftsView.chat` / `.project`**

Sites to update (line numbers from the current branch):

- `:286` — `composerChatText: composerUi.composerDrafts.chat` → `composerChatText: composerDraftsView.chat`
- `:412` — `currentMentionQuery(composerUi.composerDrafts.chat)` → `currentMentionQuery(composerDraftsView.chat)` (also fix the dep array on the same `useMemo`)
- `:413` — same for `.project`
- `:1660` — `projectComposerText: composerUi.composerDrafts.project` → `projectComposerText: composerDraftsView.project`
- `:1661` — `chatComposerText: composerUi.composerDrafts.chat` → `chatComposerText: composerDraftsView.chat`

For the `:221` and `:612` sites (`composerDrafts: composerUi.composerDrafts`), these pass the value down to hooks that expect the **read view**. Pass the projection instead:

- `:221` — change to `composerDrafts: composerDraftsView`
- `:612` — change to `composerDrafts: composerDraftsView`

- [ ] **Step 4: Migrate the two direct write call sites**

Lines 820 and 844 currently do:

```ts
composerUi.setComposerDrafts((current) => ({ ...current, project: '' }));
// ...
composerUi.setComposerDrafts((current) => ({ ...current, chat: '' }));
```

These are the project-create and select-new-chat flows. Replace each with the per-session helper. The session id is the placeholder/draft id that the flow just created or selected.

For `handleCreateProjectSession` (around line 810–835), the flow calls `selectProjectSession(projectId, draftSessionId)` immediately before the clear. Use `draftSessionId`:

```ts
composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'project', draftSessionId, ''));
```

For `selectNewChatSession` (around line 841–853), the flow has `sessionId` as its argument. Use it:

```ts
composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'chat', sessionId, ''));
```

(Both clears were originally there to reset the global slot when the active id changed. Under per-session keying these clears are technically redundant — the new id starts empty by default — but keeping the explicit clear is a no-op for fresh ids and a useful belt-and-braces clear if a stale draft was somehow stored under that id.)

- [ ] **Step 5: Stage but do not commit**

```bash
git add app/desktop/src/app/useKordiAppModel.ts
```

---

## Task 8: Migrate mention insertion in `useComposerMessageActions`

**Files:**
- Modify: `app/desktop/src/features/chat/useComposerMessageActions.ts`

- [ ] **Step 1: Add the helper import**

At the top of the file, add:

```ts
import { updateScopeDraft } from './composerDrafts';
```

**Context for steps 2 and 3:** Inside this hook, `composerDrafts` is the **read view** (`Record<ComposerScope, string>`) passed in from `useKordiAppModel` (Task 7). `setComposerDrafts` is the **raw setter** for `ComposerDraftState`. The mention-insert callback reads the current text from the view (a string) and writes a new value through the raw setter.

If `activeConvId` and `activeProjectSessionId` are not already destructured args of this hook, check the args block (around `useComposerMessageActions.ts:90–130`) — they are already part of `UseComposerControllerArgs` and just need to be added to the `Pick<...>` and destructure list.

- [ ] **Step 2: Replace the chat mention-insert callback**

Find (around line 253):

```ts
setComposerDrafts((current) => ({ ...current, chat: insertMentionIntoDraft(current.chat, label) }));
```

Replace with:

```ts
setComposerDrafts((current) => updateScopeDraft(
  current,
  'chat',
  activeConvId,
  insertMentionIntoDraft(composerDrafts.chat, label),
));
```

Update the surrounding `useCallback` dep array to include `activeConvId`:

```ts
}, [activeConvId, composerDrafts.chat, setComposerDrafts]);
```

- [ ] **Step 3: Replace the project mention-insert callback**

Around line 258, find:

```ts
setComposerDrafts((current) => ({ ...current, project: insertMentionIntoDraft(current.project, label) }));
```

Replace with:

```ts
setComposerDrafts((current) => updateScopeDraft(
  current,
  'project',
  activeProjectSessionId ?? '',
  insertMentionIntoDraft(composerDrafts.project, label),
));
```

(`activeProjectSessionId` may be undefined when no project session is active. `updateScopeDraft` short-circuits on an empty session id, so the call is a safe no-op in that case.)

Update the dep array to include `activeProjectSessionId`:

```ts
}, [activeProjectSessionId, composerDrafts.project, setComposerDrafts]);
```

- [ ] **Step 4: Stage but do not commit**

```bash
git add app/desktop/src/features/chat/useComposerMessageActions.ts
```

---

## Task 9: Migrate chat send-clear sites and `useDesktopSessionController`, then run typecheck

**Files:**
- Modify: `app/desktop/src/features/chat/messageActions/chatMessages.ts`
- Modify: `app/desktop/src/features/chat/useDesktopSessionController.ts`

- [ ] **Step 1: Add the helper import**

At the top of `app/desktop/src/features/chat/messageActions/chatMessages.ts`, add:

```ts
import { updateScopeDraft } from '../composerDrafts';
```

- [ ] **Step 2: Replace each `setComposerDrafts((current) => ({ ...current, chat: '' }))` clear**

There are six sites in this file (lines 465, 582, 778, 891, 925, 1052 in the current branch). At each site, the surrounding code already knows the target session id — it is the session being sent to. Inspect each call site (use `git grep -n "chat: ''" app/desktop/src/features/chat/messageActions/chatMessages.ts` to find them) and identify the local variable that holds the target session id (commonly named `targetSessionId`, `resolvedSessionId`, `nextSessionId`, or `sessionId`).

Replace each occurrence with the per-session helper, using the appropriate local id:

```ts
setComposerDrafts((current) => updateScopeDraft(current, 'chat', /* the local target session id */, ''));
```

If a particular call site genuinely cannot reach the target session id from local scope, propagate it through the surrounding callback's args until it can — these clears all happen after a successful send, where the target id is necessarily defined.

- [ ] **Step 3: Update `useDesktopSessionController.ts`**

In `app/desktop/src/features/chat/useDesktopSessionController.ts`:

1. At the top of the file, add:

```ts
import { updateScopeDraft, type ComposerDraftState } from './composerDrafts';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from './draftSessions';
```

(Verify `LOCAL_DRAFT_CHAT_CONVERSATION_ID` is already imported elsewhere in this file; if so, do not duplicate.)

2. Replace the inline type on line 57:

```ts
setComposerDrafts: Dispatch<SetStateAction<Record<'chat' | 'project', string>>>;
```

with:

```ts
setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
```

3. Replace the clear at line 122:

```ts
setComposerDrafts((current) => ({ ...current, chat: '' }));
```

with:

```ts
setComposerDrafts((current) => updateScopeDraft(current, 'chat', LOCAL_DRAFT_CHAT_CONVERSATION_ID, ''));
```

The active id at this point is the local draft placeholder (set on the previous line via `setActiveConvId(LOCAL_DRAFT_CHAT_CONVERSATION_ID)`), so the clear correctly targets the placeholder's draft entry.

- [ ] **Step 4: Run typecheck across the whole desktop app**

Run: `cd app/desktop && pnpm typecheck`
Expected: clean (zero errors).

If errors appear, they should be one of:
- A missed `composerUi.composerDrafts.chat` / `.project` read — fix by switching to `composerDraftsView`.
- A missed `setComposerDrafts((c) => ({ ...c, chat: ... }))` write — fix with `updateScopeDraft(...)`.
- A reference to the old `Record<ComposerScope, string>` type — `ComposerDraftState` is now imported from `composerDrafts.ts`; the old import path is fine because Task 4 re-exports it.

- [ ] **Step 5: Run the existing test suite**

Run: `cd app/desktop && pnpm test:unit`
Expected: all tests pass, including the new helper tests from Tasks 1–3.

- [ ] **Step 6: Commit the migration as one unit**

```bash
git add app/desktop/src/features/chat/composerController.types.ts app/desktop/src/app/useKordiLocalUiState.ts app/desktop/src/features/chat/useComposerInputActions.ts app/desktop/src/app/useKordiAppModel.ts app/desktop/src/features/chat/useComposerMessageActions.ts app/desktop/src/features/chat/messageActions/chatMessages.ts app/desktop/src/features/chat/useDesktopSessionController.ts
git commit -m "Key composer drafts by session id (#213)"
```

---

## Task 10: Behavior integration test

**Files:**
- Create: `app/desktop/tests/composerDraftsBehavior.test.tsx`

This test exercises the round-trip behavior end-to-end against `useKordiLocalUiState` plus the typing handlers. We test the data layer rather than the rendered UI because the UI mounts the entire shell and is not a focused harness.

- [ ] **Step 1: Write the failing test**

Create `app/desktop/tests/composerDraftsBehavior.test.tsx`:

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_COMPOSER_DRAFT_STATE,
  updateScopeDraft,
  parseStoredComposerDrafts,
  serializeStoredComposerDrafts,
  readStoredComposerDrafts,
  writeStoredComposerDrafts,
  COMPOSER_DRAFTS_STORAGE_KEY,
} from '../src/features/chat/composerDrafts';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem:    (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem:    (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

test('typing in chat A then switching active id to chat B leaves B empty and preserves A', () => {
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'hello A', 1000);

  // Switching the active id is a UI concern; the projection chooses which entry to display.
  const viewForA = state.chat['session-A']?.text ?? '';
  const viewForB = state.chat['session-B']?.text ?? '';
  assert.equal(viewForA, 'hello A');
  assert.equal(viewForB, '');

  // Switch back: A still has its draft.
  assert.equal(state.chat['session-A']?.text ?? '', 'hello A');
});

test('sending in A clears A but leaves B untouched', () => {
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'hello A', 1000);
  state = updateScopeDraft(state, 'chat', 'session-B', 'hello B', 1500);

  // Send-clear for A:
  state = updateScopeDraft(state, 'chat', 'session-A', '', 2000);

  assert.equal(state.chat['session-A'], undefined);
  assert.equal(state.chat['session-B']?.text ?? '', 'hello B');
});

test('drafts survive a write/read round-trip via storage helpers', () => {
  const storage = fakeStorage();
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'persistent draft', 1000);

  writeStoredComposerDrafts(state, storage);
  const restored = readStoredComposerDrafts(storage, 1500);

  assert.deepEqual(restored, state);
});

test('manual clear (deleting all text) deletes the entry from storage on the next write', () => {
  const storage = fakeStorage();
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'will be deleted', 1000);
  writeStoredComposerDrafts(state, storage);
  assert.ok(storage.data.has(COMPOSER_DRAFTS_STORAGE_KEY));

  state = updateScopeDraft(state, 'chat', 'session-A', '', 2000);
  writeStoredComposerDrafts(state, storage);
  // Both scopes empty → storage key is removed:
  assert.equal(storage.data.has(COMPOSER_DRAFTS_STORAGE_KEY), false);
});

test('project scope mirrors chat scope behavior', () => {
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'project', 'project-session-A', 'project text', 1000);
  state = updateScopeDraft(state, 'project', 'project-session-B', 'other project text', 1500);

  state = updateScopeDraft(state, 'project', 'project-session-A', '', 2000);
  assert.equal(state.project['project-session-A'], undefined);
  assert.equal(state.project['project-session-B']?.text ?? '', 'other project text');
});

test('serialization round-trips an arbitrary state', () => {
  const state = updateScopeDraft(
    updateScopeDraft(EMPTY_COMPOSER_DRAFT_STATE, 'chat', 'session-A', 'A', 1000),
    'project', 'project-A', 'P', 2000,
  );
  assert.deepEqual(parseStoredComposerDrafts(serializeStoredComposerDrafts(state)), state);
});
```

- [ ] **Step 2: Run the new test**

Run: `cd app/desktop && pnpm test:unit -- tests/composerDraftsBehavior.test.tsx`
Expected: all tests passing (because Tasks 1–3 already implemented every helper used here; this test exists to lock in end-to-end behavior).

- [ ] **Step 3: Commit**

```bash
git add app/desktop/tests/composerDraftsBehavior.test.tsx
git commit -m "Add behavior tests for per-session composer drafts (#213)"
```

---

## Task 11: Prune drafts on chat session deletion

**Files:**
- Modify: `app/desktop/src/app/useKordiAppModel.ts`

- [ ] **Step 1: Locate `optimisticallyRemoveChatSession`**

It is at `useKordiAppModel.ts:706`. Both `handleArchiveChatSession` (line 717) and `handleDeleteChatSession` (line 736) call it. Pruning the draft here covers both flows.

- [ ] **Step 2: Add the prune call**

Inside `optimisticallyRemoveChatSession`, after the existing state mutations (`setLocallyHiddenSessionIds`, `setDesktopChatState`, `setCanonicalSessionState`), add:

```ts
composerUi.setComposerDrafts((current) => updateScopeDraft(current, 'chat', sessionId, ''));
```

Update the `useCallback` dep array to include `composerUi.setComposerDrafts`.

- [ ] **Step 3: Add a unit test for the prune behavior**

Append to `app/desktop/tests/composerDraftsBehavior.test.tsx`:

```tsx
test('prune-on-delete removes the entry for a session', () => {
  let state = EMPTY_COMPOSER_DRAFT_STATE;
  state = updateScopeDraft(state, 'chat', 'session-A', 'leftover', 1000);
  state = updateScopeDraft(state, 'chat', 'session-B', 'untouched', 1500);

  // Simulate the prune that runs on optimisticallyRemoveChatSession:
  state = updateScopeDraft(state, 'chat', 'session-A', '', 2000);

  assert.equal(state.chat['session-A'], undefined);
  assert.equal(state.chat['session-B']?.text ?? '', 'untouched');
});
```

- [ ] **Step 4: Run typecheck and tests**

Run: `cd app/desktop && pnpm typecheck && pnpm test:unit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/desktop/src/app/useKordiAppModel.ts app/desktop/tests/composerDraftsBehavior.test.tsx
git commit -m "Prune composer draft when chat session is deleted (#213)"
```

---

## Task 12: Manual UI verification

This is a UI bug, so type checks and unit tests do not prove the fix. Verify by hand.

- [ ] **Step 1: Start the desktop app**

Run: `cd app/desktop && pnpm tauri:dev`

Wait for the app window to open and chats to load.

- [ ] **Step 2: Verify draft isolation**

1. Open chat A and type some text in the input box (do not send).
2. Switch to chat B without sending.
3. Confirm the input box for chat B is **empty**.
4. Switch back to chat A.
5. Confirm chat A's text is still in the input box.

- [ ] **Step 3: Verify reload persistence**

1. Type a draft in chat A.
2. Wait ~500 ms (give the debounced write time to land).
3. Reload the app window (`Cmd-R` on macOS, or Tauri's reload menu).
4. Confirm the draft is restored when the app reopens chat A.

- [ ] **Step 4: Verify send clears**

1. Type and send a message in chat A.
2. Switch to chat B.
3. Switch back to chat A.
4. Confirm the input box is empty (the draft was cleared on send).

- [ ] **Step 5: Verify project scope**

1. Open a project session, type a draft, switch to a different project session, confirm empty.
2. Switch back, confirm draft is restored.

- [ ] **Step 6: Verify deletion prune**

1. Type a draft in chat A.
2. Delete chat A from the chat list.
3. (Optional) Inspect localStorage in DevTools: `kordi.composerDrafts.v1` should not contain chat A's session id.

- [ ] **Step 7: Final commit if any cleanup was needed**

If any of the above surfaced a bug, fix it now and commit. Otherwise, this task is just a verification gate and produces no code change.

---

## Final Checklist

After all 12 tasks are complete:

- [ ] All commits on branch `issue-213-per-chat-composer-drafts`.
- [ ] `pnpm typecheck` clean from `app/desktop`.
- [ ] `pnpm test:unit` passes.
- [ ] `pnpm lint` clean from `app/desktop`.
- [ ] Manual verification (Task 12) passed.
- [ ] Push the branch and open a PR referencing #213.

```bash
git push -u origin issue-213-per-chat-composer-drafts
gh pr create --title "Fix: per-chat composer drafts (#213)" --body "Closes #213. See docs/superpowers/specs/2026-05-04-per-chat-composer-drafts-design.md and docs/superpowers/plans/2026-05-04-per-chat-composer-drafts.md."
```

# Per-Chat Composer Drafts Design

## Goal

Fix issue #213: the chat input box currently shares one global string across every chat session. Typing in chat A and switching to chat B leaves chat A's text in chat B's input, which risks sending to the wrong recipient.

Make composer input a **per-session draft**: switching to a chat shows that chat's saved draft (or empty), and drafts persist across page reloads.

## Scope

- DM/agent chats (the `chat` composer scope).
- Project sessions (the `project` composer scope).
- Bridge sessions (`bridge:*` ids — same handling as chat).
- Persistence to `localStorage` with a size cap and TTL.

Out of scope:

- Multi-tab `BroadcastChannel` sync. Desktop is single-window per user; revisit if the web shell ever supports multi-tab.
- Composer attachments. Attachments already use their own localStorage path (`composerAttachments.ts`) and are cleared on chat switch (`useDesktopSessionController.ts:87`); this design does not change attachment behavior.
- Composer selections (mode/model/thinking). Those are scope-level, not per-session, and out of scope for this fix.

## Current shape (the bug)

`app/desktop/src/app/useKordiLocalUiState.ts:63` declares:

```ts
const [composerDrafts, setComposerDrafts] = useState<Record<ComposerScope, string>>({
  chat: '',
  project: '',
});
```

`ComposerScope = 'chat' | 'project'` (`kordi-app/types.ts:20`). One slot per scope, shared across every session inside that scope.

Every keystroke in `features/chat/useComposerInputActions.ts:411,416` writes to `current.chat` (or `current.project`). Switching the active session in `useDesktopSessionController.ts:83` (`handleSelectChatSession`) and `:127` (`handleSelectProjectSession`) updates the active session id but never touches `composerDrafts`, so the previous session's text stays visible in the new session's textarea.

## New data shape

Replace the global pair with per-session maps under each scope. Each entry carries its own `updatedAt` so the persistence layer can TTL- and cap-prune by recency without a separate parallel ref:

```ts
type ComposerDraftEntry = { text: string; updatedAt: number };
type ComposerDraftState = {
  chat:    Record<string /* sessionId */, ComposerDraftEntry>;
  project: Record<string /* sessionId */, ComposerDraftEntry>;
};
```

Empty drafts are represented as **missing keys**, not as `{ text: '', ... }`. Setters that produce an empty string for a session delete that session's key. This keeps the maps small and makes the cleanup-on-send path symmetric with the cleanup-on-delete path.

In-memory and on-disk shape are the same — `updatedAt` lives in state, not in a side ref. Read consumers never see the entry shape because all reads go through the projection below.

## Consumer API: keep the existing string shape

Most read sites consume `composerDrafts.chat` / `composerDrafts.project` as a `string` (slash-query detection in `useComposerViewModel.ts:284,291`, mention-query detection in `useKordiAppModel.ts:665,666`, send-text composition in `messageActions/chatMessages.ts:312` and `messageActions/projectMessages.ts:68`, etc.).

To avoid touching every call site, project the per-session map down to a single string at the boundary that already exposes drafts to read consumers. In `useKordiAppModel.ts` (the central hook), derive:

```ts
const currentChatSessionId    = activeConvId;
const currentProjectSessionId = desktopChatState?.activeSessionId ?? activeProjectSessionId;

const composerDraftsView = {
  chat:    composerDrafts.chat[currentChatSessionId]?.text       ?? '',
  project: composerDrafts.project[currentProjectSessionId]?.text ?? '',
};
```

Pass `composerDraftsView` to every existing read site that currently receives `composerDrafts`. Pass the raw `composerDrafts` map plus the active session ids to the **write** sites (input handlers, mention insert, send paths, delete paths).

This keeps `useComposerViewModel.ts` and slash/mention/transcript code unchanged.

## Mutation site changes

Three classes of write sites need updating.

### Typing

`features/chat/useComposerInputActions.ts:411` (chat) and `:416` (project) currently splat the scope:

```ts
setComposerDrafts((current) => ({ ...current, chat: value }));
```

New:

```ts
setComposerDrafts((current) => updateScopeDraft(current, 'chat', activeConvId, value));
```

Where `updateScopeDraft` is a helper colocated with the new persistence module:

```ts
function updateScopeDraft(
  state: ComposerDraftState,
  scope: ComposerScope,
  sessionId: string,
  value: string,
  now: number = Date.now(),
): ComposerDraftState {
  const next = { ...state[scope] };
  if (value === '') {
    if (!(sessionId in next)) return state;
    delete next[sessionId];
  } else {
    const existing = next[sessionId];
    if (existing && existing.text === value) return state;
    next[sessionId] = { text: value, updatedAt: now };
  }
  return { ...state, [scope]: next };
}
```

The early returns ensure no-op updates don't trigger a re-render or a needless persistence write.

The handler signature already has `activeConvId` (or the active project session id) available via the `useKordiAppModel` wiring, since they're already used to dispatch sends.

### Mention insertion

`features/chat/useComposerMessageActions.ts:253,258` does the same splat-on-scope pattern with a transformation. Replace with the per-session helper, reading the current session's value via `current[scope][sessionId]?.text ?? ''`. Like the typing handlers, the mention-insert callbacks must include the active session ids in their `useCallback` dep arrays so the captured ids are always current.

### Send clears

Every site that currently does `setComposerDrafts((current) => ({ ...current, chat: '' }))` becomes "delete the entry for the session that was just sent":

- `features/chat/messageActions/chatMessages.ts:336, 532, 645, 679, 794` — chat scope.
- `features/chat/messageActions/projectMessages.ts` (the equivalent clear sites) — project scope.

In every case the send path already knows the target session id (it's what's being sent to), so plumb that in and call `updateScopeDraft(current, scope, sessionId, '')` (which deletes the key, since `value === ''`).

### Chat-creation path

`features/chat/useDesktopSessionController.ts:122` clears the chat draft when the user creates a new chat (active id becomes `LOCAL_DRAFT_CHAT_CONVERSATION_ID`). Keep this clear: it ensures the placeholder id starts clean even if a stale draft was somehow stored under it.

### Switch-chat / switch-project paths

`handleSelectChatSession` and `handleSelectProjectSession` do **not** need to mutate drafts. Selecting a different session id naturally surfaces that session's draft (or `''` if missing) through `composerDraftsView`. This is the change that fixes the bug.

## Cleanup on session deletion

When a chat or project session is deleted, prune its draft entry so the maps don't accumulate dead keys.

- `app/desktop/src/app/useKordiAppModel.ts:964–986` — both `removeChatSession`-style call sites. After successful deletion (server confirmed or optimistic), call `setComposerDrafts((current) => updateScopeDraft(current, 'chat', sessionId, ''))`.
- The corresponding project-session deletion path: same shape, scope `'project'`.

Bridge sessions: handled identically since they are just string ids in the `chat` map.

## Persistence

Mirror the pattern in `features/chat/composerAttachments.ts`.

- New module: `app/desktop/src/features/chat/composerDrafts.ts`.
- Storage key: `kordi.composerDrafts.v1`.
- On-disk shape is identical to the in-memory shape (`ComposerDraftState` from above), serialized as JSON.
- Helpers: `parseStoredComposerDrafts(raw)`, `serializeStoredComposerDrafts(state)`, `readStoredComposerDrafts(storage?)`, `writeStoredComposerDrafts(state, storage?)`. Same `ComposerDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>` boundary used by attachments, so tests can pass a fake `Storage`.
- **TTL**: drop entries with `updatedAt` older than 30 days (`30 * 24 * 60 * 60 * 1000` ms) on read.
- **Cap**: after TTL pruning, if a scope still has more than 200 entries, keep the 200 most recent by `updatedAt`.
- **Empty-state**: if the resulting `chat` and `project` maps are both empty, `removeItem` the key (matches attachments).
- **Parse errors / non-object / missing scopes / non-finite `updatedAt` / non-string `text`**: drop the bad entry; never throw. If the whole payload is unparseable, return `{ chat: {}, project: {} }`.

### Wiring

In `useKordiLocalUiState.ts`:

- Lazy initializer reads from storage:

```ts
const [composerDrafts, setComposerDrafts] = useState<ComposerDraftState>(
  () => readStoredComposerDrafts(),
);
```

- A `useEffect` watches `composerDrafts` and writes to storage after a 300 ms debounce. The timestamp is already on each entry (set by `updateScopeDraft`), so the write is a direct `writeStoredComposerDrafts(composerDrafts)` — no extra bookkeeping.
- The debounce timer is cleared on unmount and on every `composerDrafts` change, so only the trailing edge fires.

### Why `Date.now` per entry instead of a single global timestamp

Per-entry timestamps let TTL/cap prune the oldest drafts even when other entries are still being touched. A single global timestamp would either keep everything alive forever or evict everything together.

## Edge cases

- **`LOCAL_DRAFT_CHAT_CONVERSATION_ID` placeholder.** When the user types in a freshly-created chat, the active id is the placeholder. The draft is stored under the placeholder id. On send the existing clear paths run with the placeholder as the active id and delete it. The send creates a real session id only after submission, so there is no draft to migrate — the draft has already been consumed and cleared.
- **Bridge ids** (`bridge:*`). Same handling as chat ids; no special case.
- **Rapid scope or session switching.** The persistence write is debounced 300 ms, but the in-memory state setter runs synchronously on every keystroke, so each keystroke lands under whatever `activeConvId` was visible to the input handler at the moment the handler was created. `useComposerInputActions` already receives `activeConvId` and `activeProjectSessionId` as hook args (lines 171–172). The new typing handlers must include those ids in their `useCallback` dep arrays — the existing handlers (lines 410, 415) only depend on `setComposerDrafts`, so this is a deliberate change. With the corrected deps the handler is recreated on every session switch, and a session switch followed by typing always writes to the new session id.
- **Switch while sending.** Sending dispatches against a captured target session id. If the user switches sessions mid-send, the post-send clear still targets the captured id, not the now-active id, so the new chat's draft is not clobbered.
- **Mention insertion off-screen.** `useComposerMessageActions.ts` only reads `composerDrafts.chat` (now `[activeConvId]`) at the moment the mention is inserted, which is always against the active chat. Same id consistency as typing.
- **Pre-existing storage.** No prior key (`kordi.composerDrafts.v1`) exists, so first read returns `{ chat: {}, project: {} }`. No migration needed.

## Tests

There's `app/desktop/tests/chatRouting.test.tsx` as a sibling pattern. Add:

### `app/desktop/tests/composerDrafts.test.ts` — pure helpers

Targets `features/chat/composerDrafts.ts`:

- `parseStoredComposerDrafts` returns `{ chat: {}, project: {} }` for `null`, `''`, malformed JSON, non-object, missing scopes.
- `serializeStoredComposerDrafts` round-trips a `ComposerDraftState`.
- TTL prune: entries older than 30 days are dropped on read.
- Cap prune: with 250 entries in `chat`, only the 200 most recently `updatedAt` survive.
- Empty-state: `writeStoredComposerDrafts({ chat: {}, project: {} })` calls `removeItem`.

### `app/desktop/tests/composerDraftsBehavior.test.tsx` — integration

Mounts the relevant slice of the desktop shell (or a focused test harness around `useKordiLocalUiState` + the input handler):

- Type in chat A (`sessionA`), switch active id to `sessionB` → composer view string is empty for B.
- Switch back to A → A's text is restored.
- Send in A → A's draft is cleared, B's draft is unchanged.
- Type a draft, simulate page reload (re-mount with localStorage intact) → draft still there.
- Manually clear the input (delete all text) → entry deleted from storage on next debounced flush.
- Delete `sessionA` → draft for A is gone.
- Project scope mirrors all of the above.

## Summary of files touched

- `app/desktop/src/app/useKordiLocalUiState.ts` — new state shape, persistent init, debounced write effect.
- `app/desktop/src/features/chat/composerDrafts.ts` — **new module**: types, helpers, `updateScopeDraft`, parse/serialize/read/write.
- `app/desktop/src/app/useKordiAppModel.ts` — derive `composerDraftsView`, plumb active session ids to write sites, prune on session deletion.
- `app/desktop/src/features/chat/useComposerInputActions.ts` — typing handlers use `updateScopeDraft`.
- `app/desktop/src/features/chat/useComposerMessageActions.ts` — mention insertion uses `updateScopeDraft`.
- `app/desktop/src/features/chat/messageActions/chatMessages.ts` — send-clear sites pass session id.
- `app/desktop/src/features/chat/messageActions/projectMessages.ts` — same.
- `app/desktop/src/features/chat/useDesktopSessionController.ts` — keep the placeholder-id clear on chat creation; no other change.
- `app/desktop/tests/composerDrafts.test.ts`, `app/desktop/tests/composerDraftsBehavior.test.tsx` — new tests.

## Acceptance criteria (from issue #213)

- [x] Typing in chat A and switching to chat B shows an empty input in chat B (assuming B has no draft) — addressed via per-session keying.
- [x] Switching back to chat A restores the previously typed text — addressed.
- [x] Drafts persist across page reloads — localStorage with debounced write.
- [x] Sending a message clears that chat's draft — send-clear sites updated.
- [x] Manually clearing the input (deleting all text) clears the saved draft for that chat — empty value deletes the key, write effect persists the deletion.
- [x] No draft leaks across chats, workspaces, or accounts — keyed by session id, which is unique per chat. Workspace/account isolation: localStorage is per-origin, and current desktop shell is single-account; if multi-account is added later, prefix the key with the account id.

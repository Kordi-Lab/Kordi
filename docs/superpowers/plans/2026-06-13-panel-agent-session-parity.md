# Side-Panel Agent Session Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the side-panel Agent chat behave like the normal Agent session, with the same send/receive behavior, composer, attachments, forwarding, details, and right-side expansion. The only difference should be placement: main pane vs side pane.

**Architecture:** Extract the existing main Agent chat pane into a reusable `ChatSessionPane`, including transcript, live turn, composer, attachments, quote/reply, forwarding, selection, message details, and right detail expansion hooks. Render the same pane implementation for both the main Agent chat and the side-panel Agent chat. Extract shared local-agent send logic so both panes use the same canonical optimistic persistence and desktop live-turn pipeline.

**Tech Stack:** React/TypeScript, Node `node:test`, Tauri desktop local chat bridge, Kordi canonical session read model, existing `MessageBubble`, `LiveChatTurnMessage`, composer utilities, message action utilities.

---

## Updated Product Requirement

The side-panel Agent chat is not a reduced preview. It is a full Agent session displayed in a different place.

Placement-specific side-panel chrome must be preserved: the `...` options button and `X` close button shown in the provided screenshot stay as side-panel controls. The shared Agent session UI replaces the session body/transcript/composer behavior, not the side-panel placement controls.

It must support the same user-facing capabilities as a normal Agent session:

- send messages
- receive live and completed assistant messages
- keep sent messages visible immediately
- use the same composer behavior
- attach files/images
- reply/quote messages
- forward messages
- open message details
- select/copy/forward selected messages where applicable
- show message action menu parity
- support detail expansion on its right side
- show model/runtime controls where the normal Agent session shows them

The side panel must not maintain bespoke transcript or composer UI that drifts from the normal Agent chat. It may keep side-panel-only chrome such as options, switch chat, new chat, and close controls.

---

## Root Cause Findings

1. `ChatsPage.tsx` currently has two implementations:
   - Main Agent chat path: full transcript + composer + action wiring.
   - Side-panel path: bespoke transcript map and bespoke composer textarea/send button, plus side-panel-specific chrome (`...` options and close). The chrome should stay; the bespoke session body should not.

2. Side-panel local sends go through `sendTargetedChatMessage()` in `chatMessages.ts`.
   - That branch starts a desktop turn and updates desktop summaries.
   - For inactive sessions, side-panel messages are sourced from cached/canonical state, not the active session message list.
   - This explains sent side-panel messages disappearing/reverting.

3. Existing main-chat action handlers are active-session scoped.
   - They must become target-session aware before side-panel can safely use them.
   - Do not blindly pass active `reply/select/pin/detail` handlers into the side panel.

4. Existing code to reuse:
   - `MessageBubble` and context menu action props in `kordi-app/components/transcript.tsx`
   - `LiveChatTurnMessage` in `kordi-app/components/transcriptLiveTurns.tsx`
   - main composer JSX in `ChatsPage.tsx`
   - canonical optimistic helpers in `features/chat/messageActions/optimistic.ts`
   - draft helpers in `features/chat/composerDrafts.ts`
   - message action metadata/helpers already used by main chat

---

## RED Tests Already Added

File:

`app/desktop/tests/panelAgentSessionParity.test.ts`

Command:

```bash
pnpm --dir app/desktop exec tsx --test tests/panelAgentSessionParity.test.ts
```

Expected current pre-implementation result:

```text
# tests 3
# pass 0
# fail 3
```

The RED tests require:

1. A shared `ChatSessionPane` used by main Agent chat and side-panel Agent chat.
2. Side-panel placement controls remain present: `...` options and `X` close.
3. A shared pane containing transcript, composer, attachments, forward, details, and right expansion hooks.
4. A shared `sendLocalAgentChatMessage` send pipeline used by both active and side-panel local-agent sends.

---

## File Map

### Modify

- `app/desktop/src/pages/ChatsPage.tsx`
  - Extract full main Agent chat pane into `ChatSessionPane`.
  - Extract full composer into `ChatComposerShell` or equivalent local component.
  - Render `ChatSessionPane` for main chat and side-panel chat.
  - Remove bespoke side-panel transcript map and bespoke side-panel textarea composer.
  - Wire details/right expansion for side-panel pane.

- `app/desktop/src/features/chat/messageActions/chatMessages.ts`
  - Extract shared `sendLocalAgentChatMessage` pipeline.
  - Make active chat and side-panel local sends call it.

- `app/desktop/src/app/useKordiAppModel.ts`
  - Make reply/forward/select/detail/attachment/quote state target-session aware where needed.

- `app/desktop/src/app/kordiShellSlots.types.ts`
  - Update prop types if target-scoped handlers are added.

- `app/desktop/src/app/mainContentShellBuilders.ts`
  - Forward new target-scoped props into `ChatsPage` if needed.

- `app/desktop/tests/panelAgentSessionParity.test.ts`
  - Keep as RED/GREEN contract. Update only if naming is intentionally changed and reviewed.

---

## Task 1: Confirm RED State

- [ ] **Step 1: Confirm no production code changes**

Run:

```bash
git status --short
```

Expected before implementation:

```text
?? app/desktop/tests/panelAgentSessionParity.test.ts
?? docs/superpowers/plans/2026-06-13-panel-agent-session-parity.md
```

- [ ] **Step 2: Run RED test**

```bash
pnpm --dir app/desktop exec tsx --test tests/panelAgentSessionParity.test.ts
```

Expected:

```text
# tests 3
# pass 0
# fail 3
```

---

## Task 2: Extract Full `ChatSessionPane`

**Goal:** There is one Agent chat pane implementation.

**File:** `app/desktop/src/pages/ChatsPage.tsx`

- [ ] **Step 1: Identify main Agent chat pane boundaries**

The pane includes:

- header-relevant session state already computed in `ChatsPage`
- pinned message bar
- transcript scroll area
- `MessageBubble` map
- `LiveChatTurnMessage`
- queued messages
- message selection bar
- quote preview
- attachment previews
- textarea
- slash/mention menus
- runtime status
- model controls
- send/stop controls

- [ ] **Step 2: Extract reusable `ChatSessionPane`**

Create a local component in `ChatsPage.tsx` above `ChatsPage`:

```tsx
type ChatSessionPaneProps = {
  conversation: Conversation;
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  liveTurnSender: string;
  shouldRenderLiveTurn: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onTranscriptScroll?: () => void;

  pinnedMessage?: Message | null;
  pinnedMessageId?: string | null;
  onOpenPinnedMessage?: () => void;
  onRequestPinMessage?: (message: Message) => void;
  onRequestUnpinMessage?: (message: Message) => void;

  onOpenSource: (file: EditFilePreview) => void;
  onOpenArtifact: (artifactId: string) => void;
  onOpenAuthSettings: () => void;
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
  onOpenMessageDetail?: (message: Message) => void;
  onStopBridgeAgentRequest: NonNullable<ComponentProps<typeof MessageBubble>['onStopBridgeAgentRequest']>;
  onStopActiveTurn?: () => void;
  onRequestBridgeContact?: ComponentProps<typeof MessageBubble>['onRequestBridgeContact'];

  onReplyMessage?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
  selectionMode?: boolean;
  selectedMessageCount?: number;
  selectedMessageIds?: ReadonlySet<string>;
  isMessageSelectable?: (message: Message) => boolean;
  onToggleSelectedMessage?: (message: Message) => void;
  onSelectionDragStart?: (message: Message, shouldSelect: boolean) => void;
  onSelectionDragEnter?: (message: Message) => void;
  onSelectionDragEnd?: () => void;
  onCancelMessageSelection?: () => void;
  onCopySelectedMessages?: () => void;
  onForwardSelectedMessages?: () => void;

  composer: ChatComposerShellProps;
  rightDetailRail?: ReactNode;
  isDetailPanelCollapsed?: boolean;
  setIsDetailPanelCollapsed?: Dispatch<SetStateAction<boolean>>;
};
```

The exact prop list can be refined during implementation, but the boundary must be a full session pane, not only transcript.

- [ ] **Step 3: Move existing main transcript/composer JSX into `ChatSessionPane`**

Do not rewrite UI from scratch. Move existing JSX and parameterize values.

- [ ] **Step 4: Replace main chat area with `ChatSessionPane`**

Main chat passes active session values.

- [ ] **Step 5: Replace side-panel custom UI with `ChatSessionPane`**

Side panel passes companion session values.

Remove from side panel:

- bespoke `companionTranscriptMessages.map(... <MessageBubble ... />)`
- bespoke `<textarea data-composer-scope="companion" />`
- bespoke side-panel send button shell

The side panel must keep layout/header controls, including the `...` options button and `X` close button shown in the provided screenshot, but the session body must be the shared pane.

---

## Task 3: Extract Full `ChatComposerShell`

**Goal:** Main and side-panel Agent sessions use the same composer UI and capabilities.

**File:** `app/desktop/src/pages/ChatsPage.tsx`

- [ ] **Step 1: Extract current main composer JSX**

Create local component:

```tsx
type ChatComposerShellProps = {
  conversation: Conversation;
  draftText: string;
  attachments: Attachment[];
  quote?: ComposerQuoteState | null;
  isSending: boolean;
  canSend: boolean;
  placeholder: string;

  attachmentInputRef?: RefObject<HTMLInputElement | null>;
  saveDesktopAttachments?: (files: File[]) => Promise<Attachment[]>;
  saveDesktopAttachmentPaths?: (paths: string[]) => Promise<Attachment[]>;
  removeAttachment?: (id: string) => void;

  onDraftChange: (value: string, target: HTMLTextAreaElement) => void;
  onSend: () => void;
  onStop?: () => void;
  onClearQuote?: () => void;

  filteredSlashCommands?: DesktopChatSlashCommand[];
  filteredMentionTargets?: ComposerMentionOption[];
  slashMenuIndex?: number;
  setSlashMenuIndex?: Dispatch<SetStateAction<number>>;
  acceptSlashCommand?: (value: string) => void;
  acceptMentionTarget?: (value: string) => void;

  runtimeContextStatus?: DesktopChatContextWindowStatus | null;
  runtimeCacheText?: string | null;
  showModelControls: boolean;
  composerSelection: { mode: string; model: string; thinking: string };
  openComposerSelector: { scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null;
  toggleComposerSelector: ChatsPageProps['toggleComposerSelector'];
  selectComposerValue: ChatsPageProps['selectComposerValue'];
  composerAuthLabel: string;
  composerAuthOptions: ComposerAuthOption[];
  selectComposerAuthChoice: ChatsPageProps['selectComposerAuthChoice'];
  selectComposerProviderChoice: ChatsPageProps['selectComposerProviderChoice'];
  composerProviderOptions: ComposerProviderOption[];
  chatModelOptions?: ComposerModelOption[];
};
```

- [ ] **Step 2: Preserve existing main composer behavior**

The extracted component must still support:

- attachment previews
- remove attachment
- paste/drop where currently supported
- slash menu
- mention menu
- quote preview
- model/runtime controls
- stop/send behavior

- [ ] **Step 3: Make side-panel composer use `ChatComposerShell`**

The side-panel composer must use the same component and support attachments.

If current attachment state is global, make it session-scoped before wiring side-panel attachments. Do not share one global attachment list between main and side composer if it causes cross-pane leakage.

---

## Task 4: Extract Shared Local-Agent Send Pipeline

**Goal:** Sending from side-panel Agent session uses the same send/receive path as normal Agent session.

**File:** `app/desktop/src/features/chat/messageActions/chatMessages.ts`

- [ ] **Step 1: Extract `sendLocalAgentChatMessage`**

Move existing active local-agent send behavior into a helper inside `useChatMessageActions()`.

The helper must handle:

- canonical optimistic user message creation
- canonical persistence
- desktop optimistic summary/message update
- attachment paths
- quote/message action metadata
- context messages
- `startDesktopChatMessage(...)`
- `watchLocalTurnAndFlushQueue(...)`
- failure state and failed canonical message persistence

- [ ] **Step 2: Active chat send calls helper**

Active Agent session send must call `sendLocalAgentChatMessage(...)`.

- [ ] **Step 3: Side-panel local send calls helper**

`sendTargetedChatMessage()` local-agent branch must call the same helper.

- [ ] **Step 4: Preserve unrelated routing**

Do not alter:

- cloud bridge direct sends
- cloud group sends
- cloud group mention sends
- no-provider shortcut behavior
- slash command behavior
- queueing while same session is running

---

## Task 5: Make State Target-Session Scoped

**Goal:** Side-panel actions affect the side-panel session, not the active main session.

**Files:**

- `app/desktop/src/app/useKordiAppModel.ts`
- `app/desktop/src/app/kordiShellSlots.types.ts` if needed
- `app/desktop/src/app/mainContentShellBuilders.ts` if needed
- `app/desktop/src/pages/ChatsPage.tsx`

- [ ] **Step 1: Quote/reply scope**

Ensure reply quote state is keyed by target session id.

Success behavior:

- Reply from main chat appears in main composer.
- Reply from side-panel chat appears in side-panel composer.

- [ ] **Step 2: Attachment scope**

Ensure attachments are keyed by target session id or otherwise isolated per pane.

Success behavior:

- Add attachment in main composer does not leak into side-panel composer.
- Add attachment in side-panel composer does not leak into main composer.
- Sending from side panel includes its attachments.

- [ ] **Step 3: Forward scope**

Forwarding from a side-panel message uses that side-panel message as source.

Success behavior:

- Forward from main message forwards main message.
- Forward from side-panel message forwards side-panel message.

- [ ] **Step 4: Details scope and right expansion**

Message detail opened from side-panel must be related to the side-panel message.

Success behavior:

- Details from main chat open main-related detail.
- Details from side-panel chat open side-panel-related detail.
- Side-panel details can expand on its right side without hijacking the main chat’s detail context.

- [ ] **Step 5: Selection scope**

Selection/copy/forward selected messages must be scoped to the pane/session where selection started.

---

## Task 6: Verification

### Automated success

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/panelAgentSessionParity.test.ts
```

Expected:

```text
# fail 0
```

Run adjacent tests:

```bash
pnpm --dir app/desktop exec tsx --test \
  tests/chatStartRouting.test.tsx \
  tests/chatsPageQuotePreview.test.tsx \
  tests/chatHeaderBadge.test.tsx
```

Expected: all pass.

Run typecheck and whitespace check:

```bash
pnpm --dir app/desktop exec tsc --noEmit --pretty false
git diff --check
```

Expected: no errors.

### Manual/product success criteria

In the local 3-user takotako desktop setup:

1. Open a normal Agent session in main pane.
2. Open an Agent session in side panel.
3. Send a message from main Agent session.
4. Send a message from side-panel Agent session.
5. Both sent messages stay visible immediately.
6. Both sessions show live assistant turns.
7. Both sessions receive completed assistant messages.
8. Side-panel send/receive feels the same as normal Agent session.
9. Attach a file/image from main composer and send it.
10. Attach a file/image from side-panel composer and send it.
11. Attachments do not leak between main and side composers.
12. Forward a main-pane message; source is correct.
13. Forward a side-panel message; source is correct.
14. Open details for a main-pane message; details are correct.
15. Open details for a side-panel message; details are correct.
16. Expand side-panel-related details on the right side; it does not hijack main chat context.
17. Side-panel header still has the `...` options button and `X` close button.
18. The `...` menu still supports side-panel actions such as new chat / switch chat.
19. Reply/quote in main pane targets main composer.
20. Reply/quote in side panel targets side-panel composer.
21. Normal Agent chat still works with no regression.
22. No React hook-order errors.
23. No CPU/error loop.
24. Edit remains removed.

---

## Non-Goals / Guardrails

- Do not restore Edit.
- Do not create a reduced side-panel-only transcript or composer.
- Do not remove side-panel-specific chrome: keep `...` options and `X` close controls.
- Do not duplicate the local-agent send pipeline.
- Do not use active-session-scoped handlers for side-panel actions without target scoping.
- Do not introduce broad/global scroll or hook changes.
- Do not change unrelated cloud/group routing.
- Do not push/open PR until RED tests, adjacent tests, typecheck, and manual verification pass.

---

## Approval Gate

Stop after this plan and RED tests. Implementation starts only after approval of this full parity direction:

- one reusable `ChatSessionPane`
- one reusable `ChatComposerShell`
- shared local-agent send pipeline
- target-scoped reply/attachment/forward/detail/right-expansion state

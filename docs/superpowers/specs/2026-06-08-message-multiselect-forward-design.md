# Message multi-select and batch forward design

## Context

Issue #487 already adds single-message Reply and Forward from the message context menu. Single-message forwarding preserves structured `messageAction.kind === 'forward'` metadata, shows a `Forwarded from ...` header, switches to the destination chat, and reveals the forwarded message.

The next step is Telegram-style multi-select forwarding. Users should be able to select several messages from the transcript and forward them to another chat in one action.

Reference behavior from Telegram:

- Enter selection mode from a message action.
- Selected messages show visible check controls.
- A persistent action bar appears with a selected count and Forward button.
- Forwarding a batch creates separate forwarded cards in the target chat, preserving original order and original attribution.

## Scope for this pass

Implement option A + C from the visual brainstorming:

1. Right-click a message and choose **Select**.
2. Enter transcript selection mode with that message selected.
3. Click message check controls to add or remove messages.
4. Show a bottom selection action bar with selected count, Cancel, and Forward.
5. Open the forward destination dialog with a compact selected-message preview and destination list.
6. Forward selected messages as separate forwarded cards in source transcript order.
7. Support both light and dark themes for the destination dialog.

Out of scope for this pass:

- Drag/range selection.
- Keyboard range selection.
- Shared caption/comment for a multi-forward batch.
- Selecting messages across multiple chats.
- Deleting, copying, or replying to a multi-selection.

Single-message forwarding keeps its existing caption behavior. Multi-message forwarding hides or omits the caption field in this pass to avoid ambiguity about whether one caption applies to every forwarded message or becomes a separate message.

## User interaction

### Enter selection mode

The existing context menu already shows a **Select** row. It should become functional:

- `Select` closes the context menu.
- The transcript enters selection mode.
- The clicked message is selected immediately.
- A bottom action bar appears.

The existing `Forward` context menu row continues to open the single-message forward flow.

### Select and deselect messages

In selection mode:

- Each selectable message row shows a circular selection control near the message.
- Clicking the control toggles that message.
- Clicking the message bubble should also toggle selection while selection mode is active, unless the click is on an interactive child such as an attachment/open button.
- Selected messages use a filled check control and a subtle selected-row highlight.
- Unselected messages use an empty check control.
- If the user deselects the last message, selection mode exits.

Only messages that can produce a `MessageActionSource` are selectable. Messages that cannot be forwarded should not show a selectable control.

### Selection action bar

The bottom action bar is rendered above the composer/transcript edge and should not obscure the forward dialog.

It contains:

- Selected count: `1 selected`, `2 selected`, etc.
- Cancel button.
- Forward button.

Actions:

- Cancel exits selection mode and clears selected messages.
- Forward opens the destination dialog.
- Escape exits selection mode when no dialog is open.

### Destination dialog

The dialog becomes batch-aware.

For a single source:

- Keep current title/copy: `Forward message`.
- Keep current caption textarea.

For multiple sources:

- Title: `Forward N messages`.
- Show a compact selected-message preview near the top.
- Omit the caption textarea.
- Show destination list.
- Confirm button: `Forward`.

Preview rules:

- Show up to three selected messages.
- Each row shows sender label and a one-line preview.
- If more than three messages are selected, show `+N more`.
- Use forwarded source text preview or attachment count fallback.

Destination list rules:

- Reuse `ForwardDestination` data.
- Keep the current excluded draft/local destination behavior.
- Use theme tokens/classes so the dialog is readable in both `body.theme-dark` and `body.theme-light`.
- Avoid hard-coded dark-only surfaces such as `bg-[#101820]/95` for the updated dialog shell.

### Batch forward confirmation

On confirm:

- Send one forwarded message per selected source.
- Preserve selected message order as it appears in the active transcript, not click order.
- Preserve each source's `MessageActionMetadata` using the existing `forwardMessageAction(source)` path.
- Use `parentMessageId: null`; forwards must not count as replies.
- Close the dialog and clear selection state.
- Switch to the destination conversation.
- Reveal/highlight the last forwarded message if an id is known; otherwise scroll to bottom.

For Cloud direct messages:

- Send each forwarded message through `encodeCloudDirectMessageEnvelope` with its own `messageAction`.
- Run sends sequentially to preserve order.
- After all sends complete, switch/reveal destination.

For canonical/group messages:

- Append each forwarded message with a stable unique id.
- Run appends sequentially to preserve order and use the latest canonical state.
- Mirror group forwards to Cloud group control using the existing group message action envelope path.
- Reveal/highlight the last appended forwarded message.

If any send fails:

- Report `Unable to forward messages` for batch failures.
- Do not leave the dialog open after a partial success unless implementation can clearly show partial status; first pass may close and surface the error through existing desktop chat error handling.

## Component and data-flow changes

### Transcript selection props

Add selection-mode props around the transcript/message rendering layer:

- `selectionMode?: boolean`
- `selectedMessageIds?: Set<string>` or equivalent serializable array at component boundary
- `onSelectMessage?: (message: Message) => void`
- `onToggleSelectedMessage?: (message: Message) => void`
- `isMessageSelectable?: (message: Message) => boolean`

`MessageContextMenuActionHandlers` gains an `onSelectMessage` callback, and the `Select` row calls it.

### App model selection state

`useKordiAppModel` owns batch selection state because it already owns active conversation, forward dialog state, destinations, and send handlers.

State shape:

- active selection conversation id
- selected message ids
- selected sources map keyed by message id/source id

Selection clears when:

- user cancels
- forward completes
- active conversation changes
- selected source can no longer be found in current transcript

### Forward dialog model

Replace single-source-only dialog state with a source array while keeping single-source compatibility:

```ts
type ForwardDialogState = {
  sources: MessageActionSource[];
  destinations: ForwardDestination[];
};
```

`MessageForwardDialog` accepts:

```ts
sources: MessageActionSource[];
onForward: (destination: ForwardDestination, caption: string) => void;
```

For now, caption is used only when `sources.length === 1`.

### Batch draft helper

Add a helper that creates forwarded drafts for multiple sources:

```ts
createForwardedMessageDrafts({ sources, caption? })
```

Rules:

- For one source, preserve current caption behavior.
- For multiple sources, ignore caption and create one draft per source.

## Accessibility and theme

- Selection controls are real buttons with `aria-pressed`.
- Each control has labels like `Select message from Alice at 13:40` or `Deselect message from Alice at 13:40`.
- The action bar announces selected count in visible text.
- The destination dialog keeps `role="dialog"`, `aria-modal="true"`, and a labeled title.
- Escape exits selection mode or closes dialog depending on active layer.
- All updated dialog and selection bar styling uses app tokens and works in dark and light themes.

## Testing plan

Use TDD. Add failing tests before implementation.

Core tests:

1. Context menu **Select** enters selection mode with the clicked message selected.
2. Selection mode shows check controls and selected count.
3. Toggling messages updates the selected count.
4. Deselecting the last message exits selection mode.
5. Forwarding multiple messages opens a dialog titled `Forward N messages` and shows selected preview rows.
6. Multi-forward sends one forwarded message per selected source in transcript order.
7. Forwarded batch messages preserve `messageAction.kind === 'forward'` and do not increment reply counts.
8. Direct Cloud batch forward sends multiple envelopes with per-message metadata.
9. Destination dialog has light/dark theme-safe selectors/tokens and no dark-only hard-coded shell.

Existing tests to keep green:

- `messageForwarding.test.tsx`
- `transcriptDensity.test.tsx`
- `cloudBridgeState.test.tsx`
- `cloudDirectMessageEnvelope.test.ts`
- `messageActionMetadata.test.ts`
- `replyAttribution.test.tsx`
- `desktopTranscriptAdapter.test.tsx`
- `bridgeAttachmentTransport.test.tsx`
- `cloudSessionActions.test.ts`

## Acceptance criteria

- A user can select multiple messages from the current chat and forward them to another chat.
- The destination chat receives separate forwarded cards in the same order as the source transcript.
- Each card shows the correct `Forwarded from ...` header with real sender names.
- The original messages do not show new reply counts from forwards.
- Selection state clears after cancel, navigation, or successful forward.
- The forward destination dialog is readable in both dark and light modes.
- No drag selection is included in this pass.

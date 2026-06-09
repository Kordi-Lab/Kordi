# Message drag selection design

## Context

The current #487 branch supports first-pass multi-select forwarding: context menu Select enters selection mode, individual check controls toggle selected messages, and the bottom action bar can forward the selected messages.

The next slice adds Telegram-style drag selection on top of the existing selection mode.

## Scope

Implement drag selection only inside active selection mode.

- Users press on a circular message selection control and drag over other message selection controls.
- If the drag starts on an unchecked message, every selectable message crossed during the drag becomes selected.
- If the drag starts on a checked message, every selectable message crossed during the drag becomes deselected.
- Drag selection is idempotent: crossing the same message multiple times does not toggle it repeatedly.
- Drag selection is scoped to the active conversation.
- If a deselect drag removes the final selected message, selection mode exits.

Out of scope:

- Freeform marquee rectangle selection.
- Dragging on the message bubble body.
- Auto-scroll while dragging near transcript edges.
- Keyboard range selection.

## Interaction details

Selection controls keep normal click behavior for one-message toggles.

For drag:

1. Pointer down on a selection control starts a drag gesture.
2. The start message is immediately set to the gesture target state.
3. Pointer entering another selection control applies the same target state to that message.
4. Pointer up, pointer cancel, or Escape ends the drag gesture.
5. The click generated after pointer down is suppressed so the start message is not toggled twice.

This intentionally limits the gesture to the check controls. It avoids interfering with text selection, attachment buttons, links, and scrolling in the message bubble.

## Architecture

Add a small pure helper module for message selection state transitions:

- set a message source selected/unselected in a given conversation
- toggle a message source in a given conversation
- clear state when no sources remain

`useKordiAppModel` uses this helper for both click toggles and drag-select gestures. The active drag gesture lives in a ref so pointer movement does not cause extra renders beyond the selected-state update.

`MessageBubble` gets optional drag callbacks:

- `onSelectionDragStart(message, shouldSelect)`
- `onSelectionDragEnter(message)`
- `onSelectionDragEnd()`

The check control calls these callbacks from pointer events and continues to expose accessible `aria-pressed` labels.

## Testing

Use TDD.

- Pure helper tests verify selecting, deselecting, toggling, idempotency, and clearing the final message.
- Transcript render tests verify selection controls expose drag metadata and selected/unselected state in markup.
- Existing multi-forward tests stay green to ensure drag selection does not alter forward metadata or reply counts.

## Acceptance criteria

- Dragging across selection controls selects multiple messages quickly.
- Dragging from a checked message deselects crossed messages.
- A dragged message is not toggled twice on click after pointer up.
- Drag selection does not activate on message bubble body.
- Multi-forward behavior remains unchanged after drag-selected messages are selected.

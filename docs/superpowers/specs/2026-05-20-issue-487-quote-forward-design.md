# Issue #487 Quote and Forward Design

## Goal
Add message-level **Quote** and **Forward** interactions on current `main` (the promoted old `main-cloud`) with visible UI that matches common chat apps.

## UX decisions
- Right-clicking an eligible transcript message opens a compact context menu with **Quote** and **Forward**.
- **Quote** adds a reply-style preview above the composer with sender and excerpt. It is removable before send.
- Sent quoted messages render with a quoted source preview/reference in the message body.
- **Forward** opens a destination picker. After choosing a destination, the composer in that destination shows a forward preview before sending.
- Sent forwarded messages render Telegram-style inline: a small `Forwarded from <sender>` header at the top of the normal bubble, followed by message content. It is not a separate card.
- Processing/live placeholder rows are not eligible until terminal.

## Data model
Add lightweight message interaction metadata:

```ts
type MessageQuoteReference = {
  messageId: string;
  senderLabel?: string | null;
  text: string;
  time?: string | null;
};

type MessageForwardReference = {
  sourceMessageId: string;
  sourceSessionId?: string | null;
  senderLabel?: string | null;
  sourceChatLabel?: string | null;
};
```

Canonical message content stores these under `quote` and `forwardedFrom`. The read model maps them back to `Message.quote` and `Message.forwardedFrom`.

## Architecture
- `transcript.tsx` owns message context-menu rendering and forwarded/quote surfaces inside bubbles.
- `ChatsPage.tsx` owns active composer quote/forward preview state and destination picker UI.
- `messageActions/optimistic.ts` and `chatMessages.ts` carry composer metadata through canonical optimistic and persisted user sends.
- Cloud transport remains best-effort for MVP: metadata is preserved in local/canonical rows and Cloud group canonical rows. If a lower-level transport cannot send structured quote/forward metadata yet, it should still send the visible text/attachments and keep local UI metadata.

## Eligibility
A message can be quoted/forwarded when:
- It has text or attachments or a completed agent turn with visible final text.
- It is not a system/action/edit row.
- It is not a live/processing/typing placeholder.

## Testing
Use TDD with targeted desktop tests:
- message context menu renders Quote/Forward for eligible messages and omits/disables for processing placeholders;
- quote/forward metadata maps through canonical read model;
- composer quote/forward preview has accessible labels;
- transcript renders Telegram-style forwarded header inline, not a card.

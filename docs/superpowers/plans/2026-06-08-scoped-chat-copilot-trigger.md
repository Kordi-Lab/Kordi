# Ask Agent Side Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change PR #534 into an explicit **Ask Agent** side-session panel opened by a header button or `/ask` slash command.

**Architecture:** Keep the existing split-pane rendering foundation, but gate it behind explicit local UI state. The right-side panel opens a normal agent session, allows switching to another agent session, offers a new-session action, and attaches a compact reference to the current chat. The reference includes session metadata plus recent messages only, not the full transcript.

**Tech Stack:** React, TypeScript, existing desktop chat composer/session state.

---

## Requirements

- The main chat header shows an explicit `Ask Agent` pill button.
- Clicking `Ask Agent` opens the side panel; candidate chats do not auto-open.
- `/ask <prompt>` opens the side panel and seeds the side composer only when an agent session can open.
- `/copilot` is not a supported alias.
- The side panel uses neutral copy: no “co-pilot” or “private helper” language.
- The side panel shows a `Reference: Current chat` chip.
- The side-agent prompt includes:
  - source session title
  - source session id
  - source chat type/directness
  - participant names when available
  - recent message snippets only
- The side panel can switch between available agent sessions.
- The side panel exposes a `New session` action wired to the existing chat-session creation flow.
- Main chat sends remain unchanged except when `/ask` is consumed.

## Verification

Run:

```bash
pnpm --dir app/desktop exec tsx --test tests/chatHeaderBadge.test.tsx
```

Expected: focused side-panel/header tests pass.

Additional checks before PR ready:

```bash
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop test:unit
```

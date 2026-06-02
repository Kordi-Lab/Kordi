# Compact Chat Model Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move group and human-contact chat model controls into a compact lowercase popout menu beside attachment, with foldable provider/model/thinking sections and explicit save/cancel.

**Architecture:** Add a reusable `CompactComposerModelMenu` component next to the existing composer controls. `ChatsPage` will use the compact menu for `person` conversations (group and direct human/contact), including bridge/cloud-backed person chats when an agent route is available, while direct agent/project workflows keep `ComposerModelControls`.

**Tech Stack:** React, TypeScript, existing Kordi desktop components, `node:test` with `react-dom/server` snapshots/source guards.

---

## Tasks

1. [x] Write failing tests in `app/desktop/tests/compactComposerModelMenu.test.tsx`:
   - compact menu renders lowercase visible copy, model trigger, foldable sections, cancel/save actions.
   - `shouldUseCompactModelRouteMenu` returns true for person group/direct chats and false for owned/external agent chats.
   - source guard confirms `ChatsPage` renders compact menu before the attachment button and preserves explicit controls for agent/project paths.
2. [x] Implement `CompactComposerModelMenu` in `app/desktop/src/kordi-app/components/composer.tsx`:
   - stage provider/model/thinking in local state.
   - render a small icon button plus optional summary label.
   - render an absolute popout above the button when open.
   - use `<details>` sections for provider, model, thinking.
   - apply changes only when `save` is clicked; `cancel` resets staged state and closes.
   - keep visible labels lowercase.
3. [x] Wire `ChatsPage`:
   - export `shouldUseCompactModelRouteMenu`.
   - use compact menu in the left tools area, immediately before attachment, for `activeConv.type === 'person'`.
   - remove bulky bottom `ComposerModelControls` for those person chats.
   - keep existing explicit `ComposerModelControls` for direct owned/external agent sessions and project sessions.
   - for bridge/cloud person chats, save routes through `updateBridgeAgentRouting` when `selectedBridgeRoutingAgent` exists.
4. [x] Verify:
   - `pnpm --dir app/desktop exec tsx --test tests/compactComposerModelMenu.test.tsx tests/composerThinking.test.tsx tests/composerCopy.test.tsx tests/chatHeaderMetadata.test.tsx`
   - `pnpm --dir app/desktop typecheck`
   - `git diff --check`

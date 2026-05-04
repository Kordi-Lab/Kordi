# Transcript Live Turn Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src/kordi-app/components/transcript.tsx` below the overlong threshold by moving live-turn and tool-timeline rendering into a focused sibling module.

**Architecture:** Keep persisted message bubble chrome, compaction summaries, contacts, and transcript exports in `transcript.tsx`. Move live-turn rendering, visible-turn merge helpers, delayed status, tool timeline rows, and tool transcript detail blocks to `app/desktop/src/kordi-app/components/transcriptLiveTurns.tsx`; re-export `LiveChatTurnCard` and `LiveChatTurnMessage` from `transcript.tsx` so existing imports remain stable.

**Tech Stack:** React, TypeScript, existing desktop unit tests, ESLint.

---

### Task 1: Extract live-turn and tool-timeline rendering

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Create: `app/desktop/src/kordi-app/components/transcriptLiveTurns.tsx`

- [x] **Step 1: Capture baseline live-turn usages**

Run:
```bash
cd /Users/shuyang/kordi-worktrees/issue-235-maintainability-boundaries
rg 'LiveChatTurn|FoldableToolTimeline|ToolTranscriptBlock|ProcessingStatusCircle' app/desktop/src/kordi-app/components/transcript.tsx -n
```
Expected: `transcript.tsx` defines the live-turn/card exports and uses `LiveChatTurnCard` inside `MessageBubbleView`.

- [x] **Step 2: Move live-turn helpers and components**

Create `app/desktop/src/kordi-app/components/transcriptLiveTurns.tsx` with moved unchanged implementations for:
- `looksLikeTerminalTable`
- `DiffOutputBlock`
- `ToolTranscriptBlock`
- `ProcessingStatusCircle`
- `toolDisplayConfig` through `LiveChatTurnMessage`

Import dependencies directly in the new file: React hooks/memo, relevant lucide icons, `cn`, diff-output helpers, `MarkdownCodeBlock`, `MarkdownContent`, tool-timeline label helpers, and the `DesktopChatTurnSnapshot` type.

- [x] **Step 3: Keep transcript exports stable**

Remove the moved code and unused imports from `transcript.tsx`. Add:
```tsx
import { LiveChatTurnCard, LiveChatTurnMessage } from './transcriptLiveTurns';
export { LiveChatTurnCard, LiveChatTurnMessage };
```
Keep existing `<LiveChatTurnCard turn={msg.turn} historical={msg.turn.completed} />` usage unchanged.

- [x] **Step 4: Verify frontend behavior**

Run:
```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm maintainability:scan -- --min-lines 1000 --limit 12
git diff --check
```
Expected: unit tests, typecheck, lint, and diff check pass; maintainability scan no longer lists `app/desktop/src/kordi-app/components/transcript.tsx`.

- [x] **Step 5: Commit the extraction**

Run:
```bash
git add app/desktop/src/kordi-app/components/transcript.tsx app/desktop/src/kordi-app/components/transcriptLiveTurns.tsx docs/superpowers/plans/2026-05-03-transcript-live-turn-split.md
git commit -m "Extract transcript live turn rendering"
```

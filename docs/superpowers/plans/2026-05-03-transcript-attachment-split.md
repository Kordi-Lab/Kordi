# Transcript Attachment Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce `app/desktop/src/kordi-app/components/transcript.tsx` by moving attachment preview helpers/components into a focused sibling module without changing rendered markup or behavior.

**Architecture:** Keep `MessageBubbleView` and transcript message chrome in `transcript.tsx`. Move attachment-only constants, preview URL derivation, native open/download actions, image/file cards, and `AttachmentPreview` into `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`.

**Tech Stack:** React, TypeScript, existing desktop unit tests, ESLint.

---

### Task 1: Extract transcript attachment previews

**Files:**
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Create: `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`

- [x] **Step 1: Capture baseline attachment usages**

Run:
```bash
cd /Users/shuyang/kordi-worktrees/issue-235-maintainability-boundaries
rg 'AttachmentPreview|attachmentPreviewUrl|AttachmentActions|AttachmentImageCard|AttachmentFileCard' app/desktop/src/kordi-app/components/transcript.tsx -n
```
Expected: all attachment helpers/components live in `transcript.tsx`, and `MessageBubbleView` renders `<AttachmentPreview msg={msg} />`.

- [x] **Step 2: Move attachment helpers/components unchanged**

Create `app/desktop/src/kordi-app/components/transcriptAttachments.tsx` with the same attachment constants and functions currently in `transcript.tsx`:
```tsx
export function AttachmentPreview({ msg }: { msg: Message }) {
  // moved unchanged from transcript.tsx
}
```
Import the dependencies directly in the new file: `useState`, `convertFileSrc`, `Download`, `ExternalLink`, `FileText`, `Image`, `ImageOff`, `Button`, `displayAttachmentName`, `downloadDesktopAttachment`, `openDesktopExternalUrl`, `cn`, and `Message`/`MessageAttachment` types.

- [x] **Step 3: Import the extracted component from transcript**

Remove the moved attachment block and unused imports from `transcript.tsx`. Add:
```tsx
import { AttachmentPreview } from './transcriptAttachments';
```
Keep the existing `<AttachmentPreview msg={msg} />` call unchanged.

- [x] **Step 4: Verify frontend behavior**

Run:
```bash
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm maintainability:scan -- --min-lines 1000 --limit 12
git diff --check
```
Expected: unit tests, typecheck, lint, and diff check pass; maintainability scan reports a smaller `transcript.tsx`.

- [x] **Step 5: Commit the extraction**

Run:
```bash
git add app/desktop/src/kordi-app/components/transcript.tsx app/desktop/src/kordi-app/components/transcriptAttachments.tsx docs/superpowers/plans/2026-05-03-transcript-attachment-split.md
git commit -m "Extract transcript attachment previews"
```

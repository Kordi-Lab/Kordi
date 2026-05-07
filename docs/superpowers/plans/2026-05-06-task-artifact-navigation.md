# Task Artifact Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add task-row response/artifact navigation and reorganize the right-panel artifact model so only generated work products are artifacts.

**Architecture:** Extend task dashboard data with transcript response IDs and generated artifact IDs. Classify session files into generated artifacts, related files, and memory in `features/chat/artifacts.ts`, then render those groups separately in `ArtifactInspector`. Keep task-row controls local to the read-only dashboard and route artifact selection through existing right-panel state.

**Tech Stack:** React, TypeScript, server-rendered component tests with `react-dom/server`, node:test, existing Kordi desktop state.

---

### Task 1: Artifact classification model

**Files:**
- Modify: `app/desktop/src/kordi-app/types/message.ts`
- Modify: `app/desktop/src/features/chat/artifacts.ts`
- Test: `app/desktop/tests/artifacts.test.tsx`

- [x] Add `category?: 'artifact' | 'related' | 'memory'` to `SessionArtifact`.
- [x] Export artifact-path normalization/classification helpers.
- [x] Classify explicit deliverables/reports/prototypes as `artifact`.
- [x] Classify source/config/package/skill files as `related`.
- [x] Classify reflection lesson artifacts as `memory`.
- [x] Update tests to verify report artifacts, package/skill related files, and memory separation.

### Task 2: Reorganize ArtifactInspector UI

**Files:**
- Modify: `app/desktop/src/pages/ArtifactInspector.tsx`
- Modify: `app/desktop/src/pages/ProjectDetailPanel.tsx`
- Test: `app/desktop/tests/artifacts.test.tsx`

- [x] Render sections: `Artifacts`, `Related files`, and `Memory`.
- [x] Ensure generated artifacts are selected by default before related files.
- [x] Mark project shared sources and folder browser entries as related files.
- [x] Add SSR tests for section grouping.

### Task 3: Task-row navigation controls

**Files:**
- Modify: `app/desktop/src/features/chat/taskActivityDashboard.ts`
- Modify: `app/desktop/src/pages/TaskActivityDashboardPanel.tsx`
- Modify: `app/desktop/src/pages/ChatDetailPanel.tsx`
- Modify: `app/desktop/src/pages/ProjectDetailPanel.tsx`
- Modify: `app/desktop/src/app/assembleRightDetailSlot.tsx`
- Modify: `app/desktop/src/kordi-app/components/transcript.tsx`
- Test: `app/desktop/tests/taskActivityDashboard.test.tsx`

- [x] Add `responseMessageId` and `artifactIds` to parent task items.
- [x] Use message ID fallback to turn ID for transcript navigation.
- [x] Add response jump icon and artifact open icon on task rows.
- [x] Route artifact icon through `setActiveArtifactId` + `setActiveDetailTab('artifacts')`.
- [x] Add SSR tests for action buttons and data mapping.

### Task 4: Verification and PR update

**Files:**
- Modify PR body only after tests pass.

- [x] Run targeted tests red before implementation.
- [x] Run targeted tests green after implementation.
- [x] Run `pnpm --dir app/desktop test:unit`.
- [x] Run `pnpm --dir app/desktop typecheck`.
- [x] Run `pnpm --dir app/desktop lint`.
- [x] Run `git diff --check`.
- [x] Commit and push to PR #289.

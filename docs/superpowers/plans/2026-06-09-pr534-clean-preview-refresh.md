# PR534 Clean Preview Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the middle divider collapse button and relaunch PR #534 against a new clean Cloud backend on takotako.

**Architecture:** Keep the Ask Agent side panel but simplify the divider toolbar to drag grip + swap only. Create an isolated Cloud server deployment/service that uses a new Postgres database, then relaunch local multi-instance Tauri windows against that service through a dedicated tunnel.

**Tech Stack:** React/TypeScript desktop UI, Tauri dev multi-instance launcher, k3s on takotako, Postgres.

---

### Task 1: Remove middle divider button

**Files:**
- Modify: `app/desktop/src/pages/ChatsPage.tsx`
- Modify: `app/desktop/tests/chatHeaderBadge.test.tsx`

- [ ] Add/update a source test asserting the divider no longer contains `setIsCompanionFolded(true)`.
- [ ] Run `pnpm --dir app/desktop exec tsx --test tests/chatHeaderBadge.test.tsx` and verify the new assertion fails.
- [ ] Remove the middle divider `Columns2` hide button from `splitDivider`.
- [ ] Re-run the focused test and typecheck.

### Task 2: Stop stale local preview instances

- [ ] Stop current side-by-side multi-instance users from `.multi-instance-runtime`.
- [ ] Stop the standalone PR534 Vite preview on port 1496.
- [ ] Verify ports 1482, 1484, 1486, and 1496 are no longer serving stale UI.

### Task 3: Create clean takotako Cloud backend

- [ ] Create database `kordi_pr534_ask_agent_clean` in the existing kordi-cloud Postgres.
- [ ] Apply a k8s Deployment/Service named `kordi-cloud-server-pr534` using the current Cloud server image and the new database URL.
- [ ] Wait for rollout and verify `/health` from inside the cluster.
- [ ] Start/refresh VM-local port-forward on 17089 to `svc/kordi-cloud-server-pr534:17081`.
- [ ] Verify `http://127.0.0.1:17089/health` on takotako and through a local SSH tunnel.

### Task 4: Relaunch local instances against clean backend

- [ ] Launch user1/user2/user3 with `KORDI_CLOUD_LOCAL_PORT=17082` and `KORDI_CLOUD_VM_PORT=17089`.
- [ ] Verify ports 1482, 1484, 1486 serve source containing `Ask Agent` and no old middle divider button.
- [ ] Update PR #534 body with focused verification and clean-preview notes; do not include temporary preview URLs.

# Cloud Settings Avatar Popout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Cloud settings into a centered pop-out opened from the bottom-left avatar and add Cloud profile editing for display name/avatar.

**Architecture:** Keep Local Edition's existing Settings page intact. For Cloud Edition, hide Settings from the left nav, open a dedicated account/settings modal from the avatar trigger, and reuse existing `AuthPage` plus theme controls inside that modal. Profile updates continue through `useCloudSession.updateProfile`; cloud contacts refresh on profile-update websocket events so observers see profile changes promptly.

**Tech Stack:** React, TypeScript, existing Cloud auth/session hooks, existing cloud-server NATS event bus, node:test via `tsx`.

---

### Task 1: Cloud navigation and source-level tests

**Files:**
- Modify: `app/desktop/src/kordi-app/data/navigation.tsx`
- Modify: `app/desktop/tests/cloudSurfaceCleanup.test.ts`
- Create: `app/desktop/tests/cloudSettingsAvatarPopout.test.ts`

- [ ] Write failing tests that expect Cloud nav IDs `['chats', 'contacts', 'agents']`, stale `settings` and `projects` nav to normalize to `chats`, and a new Cloud account settings modal source to exist.
- [ ] Run `pnpm --dir app/desktop exec tsx --test tests/cloudSurfaceCleanup.test.ts tests/cloudSettingsAvatarPopout.test.ts` and confirm failure.
- [ ] Update `navItemsForEdition('cloud')` to hide both `projects` and `settings`; update normalization to redirect both to `chats`.
- [ ] Run the same tests and confirm pass.
- [ ] Commit.

### Task 2: Centered avatar settings modal

**Files:**
- Create: `app/desktop/src/pages/CloudAccountSettingsDialog.tsx`
- Modify: `app/desktop/src/pages/WorkspaceSidebar.tsx`
- Modify: `app/desktop/src/app/assembleSidebarSlot.tsx`
- Test: `app/desktop/tests/cloudSettingsAvatarPopout.test.ts`

- [ ] Extend failing tests to assert the modal includes Profile, Authentication, Theme, `AuthPage`, `SettingsValueControl`, `fileToAvatarDataUrl`, and `role="dialog" aria-label="Account settings"`.
- [ ] Run `pnpm --dir app/desktop exec tsx --test tests/cloudSettingsAvatarPopout.test.ts` and confirm failure.
- [ ] Implement `CloudAccountSettingsDialog` as a centered portal/modal with Profile/Auth/Theme tabs.
- [ ] Wire `assembleSidebarSlot` to pass Cloud auth/theme/profile settings into `WorkspaceSidebar`.
- [ ] Change Cloud avatar click in `WorkspaceSidebar` to open the centered modal; keep local popover behavior for Local Edition.
- [ ] Run tests and typecheck.
- [ ] Commit.

### Task 3: Profile sync event fanout

**Files:**
- Modify: `bridges/cloud-server/src/events/mod.rs`
- Modify: `bridges/cloud-server/src/auth/routes.rs`
- Modify: `app/desktop/src/features/cloud/useCloudContacts.ts`
- Test: `app/desktop/tests/cloudSettingsAvatarPopout.test.ts`

- [ ] Extend tests to assert `shouldRefreshCloudContactsForWsSubject` recognizes `kordi.events.account.profile.updated.<account>`.
- [ ] Add `EventBus::publish_profile_updated`.
- [ ] After `PATCH /v1/cloud/auth/me`, publish profile-updated events to accounts that have the updated account as a contact.
- [ ] Make `useCloudContacts` refresh on profile update websocket subjects.
- [ ] Run targeted tests and typecheck.
- [ ] Commit.

### Task 4: Final verification and preview

- [ ] Run `pnpm --dir app/desktop exec tsx --test tests/cloudSettingsAvatarPopout.test.ts tests/cloudSurfaceCleanup.test.ts tests/authLaunchSurface.test.ts tests/cloudEdition.test.tsx`.
- [ ] Run `pnpm --dir app/desktop typecheck`.
- [ ] Relaunch three Cloud preview instances from this worktree using preserved multi-instance data.

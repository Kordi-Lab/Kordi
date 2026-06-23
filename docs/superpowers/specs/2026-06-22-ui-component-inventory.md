# UI component inventory for dual-theme optimization

Issue: #590  
Branch: `feat/issue-590-dual-theme-ui-optimization`  
Date: 2026-06-22

## Purpose

This inventory marks the UI files checked before beginning the light/dark theme optimization. It should be used as the implementation checklist so changes cover the whole app instead of only the obvious pages.

## Coverage summary

- Total `.tsx` / `.css` files under `app/desktop/src`: 78

- Agents UI: 7 files
- Authentication/settings provider UI: 9 files
- Bridge configuration UI: 5 files
- Cloud login UI: 2 files
- Contacts page UI: 1 files
- Feature UI adapters/panels: 4 files
- Global styles and theme tokens: 9 files
- Main pages, dialogs, inspectors, rails: 15 files
- Reusable Kordi UI components: 10 files
- Root app/style entry files: 5 files
- Shared top-level components: 1 files
- Shell assembly and app frame: 7 files
- UI data/config with rendered labels/icons: 3 files

## Checked UI files

### Agents UI

- [x] `app/desktop/src/kordi-app/agents/AgentContentPane.tsx`
- [x] `app/desktop/src/kordi-app/agents/AgentCreateDialog.tsx`
- [x] `app/desktop/src/kordi-app/agents/AgentDetailPane.tsx`
- [x] `app/desktop/src/kordi-app/agents/AgentsPage.tsx`
- [x] `app/desktop/src/kordi-app/agents/AgentsSidebar.tsx`
- [x] `app/desktop/src/kordi-app/agents/components.tsx`
- [x] `app/desktop/src/kordi-app/agents/shared.tsx`

### Authentication/settings provider UI

- [x] `app/desktop/src/kordi-app/auth/AuthDetailPrimitives.tsx`
- [x] `app/desktop/src/kordi-app/auth/AuthFlowSteps.tsx`
- [x] `app/desktop/src/kordi-app/auth/AuthPage.tsx`
- [x] `app/desktop/src/kordi-app/auth/AuthProviderDetail.tsx`
- [x] `app/desktop/src/kordi-app/auth/AuthProviderGlyph.tsx`
- [x] `app/desktop/src/kordi-app/auth/AuthProviderList.tsx`
- [x] `app/desktop/src/kordi-app/auth/LmStudioModelControlCenter.tsx`
- [x] `app/desktop/src/kordi-app/auth/LocalProviderSetup.tsx`
- [x] `app/desktop/src/kordi-app/auth/OllamaModelControlCenter.tsx`

### Bridge configuration UI

- [x] `app/desktop/src/pages/bridge/BridgeConfigModals.tsx`
- [x] `app/desktop/src/pages/bridge/BridgeConfigShared.tsx`
- [x] `app/desktop/src/pages/bridge/BridgeDetailsSection.tsx`
- [x] `app/desktop/src/pages/bridge/BridgeSetupPanels.tsx`
- [x] `app/desktop/src/pages/bridge/BridgeSetupSections.tsx`

### Cloud login UI

- [x] `app/desktop/src/kordi-app/cloud/CloudLoginMarks.tsx`
- [x] `app/desktop/src/kordi-app/cloud/CloudLoginPage.tsx`

### Contacts page UI

- [x] `app/desktop/src/kordi-app/pages.tsx`

### Feature UI adapters/panels

- [x] `app/desktop/src/features/chat/messageBubbleShape.tsx`
- [x] `app/desktop/src/features/cloud/CloudContactsAdapter.tsx`
- [x] `app/desktop/src/features/cloud/CloudContactsPanel.tsx`
- [x] `app/desktop/src/features/cloud/CloudPeerChatPanel.tsx`

### Global styles and theme tokens

- [x] `app/desktop/src/styles/base.css`
- [x] `app/desktop/src/styles/shell-bubbles.css`
- [x] `app/desktop/src/styles/shell-pages.css`
- [x] `app/desktop/src/styles/shell-popovers.css`
- [x] `app/desktop/src/styles/shell-sidebar.css`
- [x] `app/desktop/src/styles/shell-transcript.css`
- [x] `app/desktop/src/styles/shell.css`
- [x] `app/desktop/src/styles/theme-overrides.css`
- [x] `app/desktop/src/styles/theme-tokens.css`

### Main pages, dialogs, inspectors, rails

- [x] `app/desktop/src/pages/ArtifactInspector.tsx`
- [x] `app/desktop/src/pages/BridgeConfigPage.tsx`
- [x] `app/desktop/src/pages/ChatCreateDialog.tsx`
- [x] `app/desktop/src/pages/ChatDetailPanel.tsx`
- [x] `app/desktop/src/pages/ChatsPage.tsx`
- [x] `app/desktop/src/pages/CloudAccountSettingsDialog.tsx`
- [x] `app/desktop/src/pages/GroupDetailsDialog.tsx`
- [x] `app/desktop/src/pages/MessageForwardDialog.tsx`
- [x] `app/desktop/src/pages/ProjectDetailPanel.tsx`
- [x] `app/desktop/src/pages/ProjectsPage.tsx`
- [x] `app/desktop/src/pages/RightDetailRail.tsx`
- [x] `app/desktop/src/pages/SessionActionOverlays.tsx`
- [x] `app/desktop/src/pages/SettingsPage.tsx`
- [x] `app/desktop/src/pages/TaskActivityDashboardPanel.tsx`
- [x] `app/desktop/src/pages/WorkspaceSidebar.tsx`

### Reusable Kordi UI components

- [x] `app/desktop/src/kordi-app/components/EditableIdentityAvatar.tsx`
- [x] `app/desktop/src/kordi-app/components/IdentityAvatar.tsx`
- [x] `app/desktop/src/kordi-app/components/composer.tsx`
- [x] `app/desktop/src/kordi-app/components/markdown.tsx`
- [x] `app/desktop/src/kordi-app/components/settings.tsx`
- [x] `app/desktop/src/kordi-app/components/transcript.tsx`
- [x] `app/desktop/src/kordi-app/components/transcriptAttachments.tsx`
- [x] `app/desktop/src/kordi-app/components/transcriptChangedFiles.tsx`
- [x] `app/desktop/src/kordi-app/components/transcriptLiveTurns.tsx`
- [x] `app/desktop/src/kordi-app/components/transcriptReplyAttribution.tsx`

### Root app/style entry files

- [x] `app/desktop/src/App.css`
- [x] `app/desktop/src/AuthPopup.tsx`
- [x] `app/desktop/src/KordiApp.tsx`
- [x] `app/desktop/src/index.css`
- [x] `app/desktop/src/kordi-app/components.tsx`

### Shared top-level components

- [x] `app/desktop/src/components/AuthNoticeBanner.tsx`

### Shell assembly and app frame

- [x] `app/desktop/src/app/AppShellFrame.tsx`
- [x] `app/desktop/src/app/MainContentSwitch.tsx`
- [x] `app/desktop/src/app/assembleKordiShellSlots.tsx`
- [x] `app/desktop/src/app/assembleMainContentSlot.tsx`
- [x] `app/desktop/src/app/assembleOverlaySlots.tsx`
- [x] `app/desktop/src/app/assembleRightDetailSlot.tsx`
- [x] `app/desktop/src/app/assembleSidebarSlot.tsx`

### UI data/config with rendered labels/icons

- [x] `app/desktop/src/kordi-app/data.tsx`
- [x] `app/desktop/src/kordi-app/data/navigation.tsx`
- [x] `app/desktop/src/kordi-app/data/settings.tsx`

## Implementation guardrails

- Review both `theme-light` and `theme-dark` behavior for every touched surface.
- Prefer semantic tokens/classes over raw `text-slate-*`, `text-white`, `bg-white/*`, `border-white/*`, and component-local `rgba()` decisions.
- Keep chat/sidebar/composer as the primary daily-use baseline before optimizing secondary pages.
- Do not remove density or technical affordances; reduce visual noise through token, depth, and contrast discipline.

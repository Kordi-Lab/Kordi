# Desktop Refactor Plan

## Goals
- reduce `app/desktop/src/KordiApp.tsx` size and state density
- make workspace selection stable and easier to reason about
- isolate layout state from feature state
- isolate auth state from page composition
- prepare for later extraction of chat, bridge, and project pages

## Regression Checklist
- [ ] chat session selection does not flicker through previous session
- [ ] project session selection does not jump on click
- [ ] project row restores remembered session reliably
- [ ] left session row width stays stable
- [ ] left session row time label stays stable on click
- [ ] auth settings page still works
- [ ] auth inline modal still works
- [ ] bridge host config still works
- [ ] project settings still save
- [ ] live chat send / stop still works
- [ ] project send still works

## Extraction Order
1. `useWorkspaceController.ts`
2. `useAppLayoutState.ts`
3. `useDesktopAuthState.ts`
4. `useDesktopChatState.ts`
5. `useBridgeState.ts`
6. `useProjectSettingsState.ts`
7. page extraction
8. shell extraction
9. component extraction
10. css split
11. backend split

## Done
- [x] `useWorkspaceController.ts`
- [x] `useAppLayoutState.ts`
- [x] `app/useKordiLocalUiState.ts`
- [x] `app/useKordiUiEffects.ts`
- [x] `app/useKordiShellViewModel.ts`
- [x] `app/useKordiShellArgs.ts`
- [x] `app/mainContentShellBuilders.ts`
- [x] `useDesktopAuthState.ts`
- [x] `features/auth/useDesktopAuthUiState.ts`
- [x] `useDesktopChatState.ts`
- [x] `useBridgeState.ts`
- [x] `useProjectSettingsState.ts`
- [x] `pages/BridgeConfigPage.tsx`
- [x] `pages/ProjectsPage.tsx`
- [x] `pages/ChatsPage.tsx`
- [x] `pages/ProjectDetailPanel.tsx`
- [x] `pages/ChatDetailPanel.tsx`
- [x] `pages/WorkspaceSidebar.tsx`
- [x] `pages/SettingsPage.tsx`
- [x] `app/AppShellFrame.tsx`
- [x] `app/MainContentSwitch.tsx`
- [x] `app/useWorkspaceViewModels.ts`
- [x] `app/assembleKordiShellSlots.tsx`
- [x] `app/assembleSidebarSlot.tsx`
- [x] `app/assembleMainContentSlot.tsx`
- [x] `app/assembleRightDetailSlot.tsx`
- [x] `app/assembleOverlaySlots.tsx`
- [x] `features/bridge/useBridgeOrchestration.ts`
- [x] `features/chat/useDesktopTranscriptAdapter.ts`
- [x] `features/chat/useComposerController.ts`
- [x] `features/chat/useComposerViewModel.ts`
- [x] `features/chat/useDesktopSessionController.ts`
- [x] `kordi-app/components.tsx` → split into `components/markdown.tsx`, `components/transcript.tsx`, `components/composer.tsx`, `components/settings.tsx`
- [x] `kordi-app/data.tsx` → split into `data/navigation.tsx`, `data/conversations.ts`, `data/directory.ts`, `data/projects.ts`, `data/settings.tsx`, `data/composer.ts`, `data/preview.ts`
- [x] `index.css` → split into `styles/base.css`, `styles/theme-tokens.css`, `styles/shell.css`, `styles/theme-overrides.css`

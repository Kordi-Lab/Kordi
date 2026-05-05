import type { ReactNode } from 'react';

import AuthPopup from '@/AuthPopup';
import { openLocalAgentChatFromArgs } from '@/app/openLocalAgentChat';
import { AuthPage } from '@/kordi-app/auth/AuthPage';

import type { OverlayShellArgs } from '@/app/kordiShellSlots.types';

export function assembleOverlaySlots(args: OverlayShellArgs) {
  const onEnterChat = (preferredModelValue?: string) => openLocalAgentChatFromArgs(args, preferredModelValue);

  const authGate = args.showAuthGate ? (
    <div
      className="app-overlay absolute inset-0 z-50 overflow-hidden p-3 backdrop-blur-[12px] sm:p-4"
      style={{ WebkitAppRegion: 'no-drag' as const }}
    >
      <AuthPage
        variant="gate"
        layoutWidth={args.windowWidth}
        isNativeShell={args.isNativeShell}
        authState={args.desktopAuthState}
        isLoading={args.isDesktopAuthLoading}
        error={args.desktopAuthError}
        selectedProviderId={args.activeLoginProviderId}
        onSelectProvider={args.selectAuthProvider}
        onOpenLogin={args.openLoginFlow}
        onRefresh={() => {
          void args.refreshDesktopAuth();
        }}
        onSelectAuthChoice={(providerId, choice) => {
          void args.handleSelectAuthChoice(providerId, choice);
        }}
        onRemoveAuthProfile={(providerId, profileId) => {
          void args.handleRemoveAuthProfile(providerId, profileId);
        }}
        onLogoutProvider={(providerId) => {
          void args.handleLogoutProvider(providerId);
        }}
        onDismissGate={args.dismissAuthGate}
        onEnterChat={onEnterChat}
      />
    </div>
  ) : null;

  const inlineAuthDialog = args.inlineAuthDialog ? (
    <AuthPopup
      embedded
      providerId={args.inlineAuthDialog.providerId}
      mode={args.inlineAuthDialog.mode}
      authority={args.inlineAuthDialog.authority}
      requireAuthority={args.inlineAuthDialog.requireAuthority}
      authState={args.desktopAuthState}
      onRequestClose={args.handleCloseInlineAuthDialog}
      onAuthUpdated={args.refreshDesktopAuth}
      onEnterChat={onEnterChat}
    />
  ) : null;

  const windowResizeHandles: ReactNode = (
    <>
      <div onMouseDown={args.startWindowResize('left')} className="absolute inset-y-6 left-0 z-30 w-2 cursor-ew-resize" aria-hidden="true" />
      <div onMouseDown={args.startWindowResize('right')} className="absolute inset-y-6 right-0 z-30 w-2 cursor-ew-resize" aria-hidden="true" />
      <div onMouseDown={args.startWindowResize('top')} className="absolute left-6 right-6 top-0 z-30 h-2 cursor-ns-resize" aria-hidden="true" />
      <div onMouseDown={args.startWindowResize('bottom')} className="absolute bottom-0 left-6 right-6 z-30 h-2 cursor-ns-resize" aria-hidden="true" />
      <div onMouseDown={args.startWindowResize('top-left')} className="absolute left-0 top-0 z-40 h-5 w-5 cursor-nwse-resize" aria-hidden="true" />
      <div onMouseDown={args.startWindowResize('top-right')} className="absolute right-0 top-0 z-40 h-5 w-5 cursor-nesw-resize" aria-hidden="true" />
      <div onMouseDown={args.startWindowResize('bottom-left')} className="absolute bottom-0 left-0 z-40 h-5 w-5 cursor-nesw-resize" aria-hidden="true" />
      <div onMouseDown={args.startWindowResize('bottom-right')} className="absolute bottom-0 right-0 z-40 h-5 w-5 cursor-nwse-resize" aria-hidden="true" />
    </>
  );

  return {
    authGate,
    inlineAuthDialog,
    windowResizeHandles,
  };
}

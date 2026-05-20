import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleOverlaySlots } from '../src/app/assembleOverlaySlots';

function overlayArgs(overrides: Record<string, unknown> = {}) {
  return {
    showAuthGate: true,
    dismissAuthGate: () => {},
    windowWidth: 1280,
    isNativeShell: true,
    desktopAuthState: null,
    isDesktopAuthLoading: false,
    desktopAuthError: null,
    activeLoginProviderId: null,
    selectAuthProvider: () => {},
    openLoginFlow: () => {},
    refreshDesktopAuth: async () => {},
    handleSelectAuthChoice: async () => {},
    handleRemoveAuthProfile: async () => {},
    handleLogoutProvider: async () => {},
    inlineAuthDialog: null,
    handleCloseInlineAuthDialog: () => {},
    startWindowResize: () => () => {},
    setActiveNav: () => {},
    chatConversations: [],
    handleSelectChatSession: async () => {},
    handleCreateChatSession: async () => {},
    ...overrides,
  };
}

test('first-run auth gate receives an enter-chat shortcut handler', () => {
  const slots = assembleOverlaySlots(overlayArgs() as never);
  const gateShell = slots.authGate as never as { props: { children: { props: Record<string, unknown> } } };
  const authPage = gateShell.props.children;

  assert.equal(typeof authPage.props.onEnterChat, 'function');
});

test('inline auth popup renders above account settings modal and keeps enter-chat shortcut handler', () => {
  const slots = assembleOverlaySlots(overlayArgs({
    showAuthGate: false,
    inlineAuthDialog: { providerId: 'openai', mode: 'api-key' },
  }) as never);
  const overlay = slots.inlineAuthDialog as never as { props: { className: string; children: { props: Record<string, unknown> } } };
  const popup = overlay.props.children;

  assert.match(overlay.props.className, /fixed inset-0/);
  assert.match(overlay.props.className, /z-\[220\]/);
  assert.equal(typeof popup.props.onEnterChat, 'function');
});

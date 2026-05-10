import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleOverlaySlots } from '../src/app/assembleOverlaySlots';

function overlayArgs(overrides: Record<string, unknown> = {}) {
  return {
    showCloudLoginGate: false,
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

test('cloud login gate takes precedence over model provider auth gate', () => {
  const slots = assembleOverlaySlots(overlayArgs({ showCloudLoginGate: true }) as never);

  assert.notEqual(slots.cloudLoginGate, null);
  assert.equal(slots.authGate, null);
});

test('first-run auth gate receives an enter-chat shortcut handler', () => {
  const slots = assembleOverlaySlots(overlayArgs() as never);
  const gateShell = slots.authGate as never as { props: { children: { props: Record<string, unknown> } } };
  const authPage = gateShell.props.children;

  assert.equal(typeof authPage.props.onEnterChat, 'function');
});

test('inline auth popup receives an enter-chat shortcut handler for cloud provider saves', () => {
  const slots = assembleOverlaySlots(overlayArgs({
    showAuthGate: false,
    inlineAuthDialog: { providerId: 'openai', mode: 'api-key' },
  }) as never);
  const popup = slots.inlineAuthDialog as never as { props: Record<string, unknown> };

  assert.equal(typeof popup.props.onEnterChat, 'function');
});

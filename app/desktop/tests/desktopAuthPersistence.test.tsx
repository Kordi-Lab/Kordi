import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createDesktopAuthSyncGuard,
  isDesktopAuthUpdateFromAnotherSource,
} from '../src/features/auth/desktopAuthSync';
import {
  resolveAuthGateForSession,
  shouldShowDesktopAuthGate,
} from '../src/features/auth/useDesktopAuthUiState';
import { AuthProviderDetail } from '../src/kordi-app/auth/AuthProviderDetail';
import { buildAuthDisplayProviders } from '../src/kordi-app/auth/model';
import type { DesktopAuthProvider, DesktopAuthState } from '../src/kordi-app/types';

function rawProvider(overrides: Partial<DesktopAuthProvider>): DesktopAuthProvider {
  return {
    id: 'openai',
    label: 'OpenAI',
    statusSummary: '[not authenticated]',
    loginHint: 'Use a saved account or key.',
    envVar: 'OPENAI_API_KEY',
    helpUrl: 'https://platform.openai.com/api-keys',
    supportsOAuth: false,
    supportsApiKey: true,
    configured: false,
    authority: null,
    baseUrl: null,
    preferredModel: null,
    options: [],
    ...overrides,
  };
}

function emptyOpenAiAuthState(): DesktopAuthState {
  return {
    authPath: '/tmp/kordi-auth.json',
    hasAnyAuth: false,
    providers: [
      rawProvider({
        id: 'openai-codex',
        label: 'OpenAI Codex',
        envVar: 'OPENAI_CODEX_OAUTH',
        helpUrl: 'https://chatgpt.com/',
        supportsOAuth: true,
        supportsApiKey: false,
      }),
      rawProvider({ id: 'openai' }),
    ],
  };
}

test('startup auth gate is a one-way resolution for the current app session', () => {
  let resolved = resolveAuthGateForSession(false, false);
  assert.equal(resolved, false);

  resolved = resolveAuthGateForSession(resolved, true);
  assert.equal(resolved, true, 'persisted or newly configured auth resolves onboarding');

  resolved = resolveAuthGateForSession(resolved, false);
  assert.equal(resolved, true, 'deleting the final credential must not reopen onboarding');

  assert.equal(resolveAuthGateForSession(false, false), false, 'a new unauthenticated app session can show onboarding');
});

test('auth gate waits for persisted auth hydration and stays hidden after session resolution', () => {
  const authState = emptyOpenAiAuthState();
  const base = {
    activeNav: 'chats' as const,
    activeSettingsSectionId: 'general' as const,
    desktopAuthState: authState,
    isNativeShell: true,
    startupGateSatisfied: false,
  };

  assert.equal(shouldShowDesktopAuthGate({
    ...base,
    isDesktopAuthLoading: true,
    isAuthGateResolvedForSession: false,
  }), false);
  assert.equal(shouldShowDesktopAuthGate({
    ...base,
    desktopAuthState: null,
    isDesktopAuthLoading: false,
    isAuthGateResolvedForSession: false,
  }), false);
  assert.equal(shouldShowDesktopAuthGate({
    ...base,
    isDesktopAuthLoading: false,
    isAuthGateResolvedForSession: false,
  }), true);
  assert.equal(shouldShowDesktopAuthGate({
    ...base,
    isDesktopAuthLoading: false,
    isAuthGateResolvedForSession: true,
  }), false);
});

test('stale auth refreshes cannot overwrite mutations or newer refreshes', () => {
  const guard = createDesktopAuthSyncGuard();
  const beforeDelete = guard.beginRefresh();

  guard.beginMutation();
  assert.equal(guard.canApplyRefresh(beforeDelete), false);

  const duringDelete = guard.beginRefresh();
  assert.equal(guard.canApplyRefresh(duringDelete), false);

  guard.finishMutation();
  assert.equal(guard.canApplyRefresh(duringDelete), false);

  const older = guard.beginRefresh();
  const latest = guard.beginRefresh();
  assert.equal(guard.canApplyRefresh(older), false);
  assert.equal(guard.canApplyRefresh(latest), true);
});

test('auth update broadcasts ignore the sender but accept other and legacy surfaces', () => {
  assert.equal(isDesktopAuthUpdateFromAnotherSource({
    type: 'auth-updated',
    sourceId: 'current',
  }, 'current'), false);
  assert.equal(isDesktopAuthUpdateFromAnotherSource({
    type: 'auth-updated',
    sourceId: 'other',
  }, 'current'), true);
  assert.equal(isDesktopAuthUpdateFromAnotherSource({ type: 'auth-updated' }, 'current'), true);
  assert.equal(isDesktopAuthUpdateFromAnotherSource({ type: 'message-updated' }, 'current'), false);
});

test('deleting the final OpenAI profile leaves a usable empty provider detail', () => {
  const authState = emptyOpenAiAuthState();
  const provider = buildAuthDisplayProviders(authState).find((item) => item.id === 'openai');
  assert.ok(provider, 'the provider catalog must remain after its final profile is deleted');
  assert.equal(provider.configured, false);

  const markup = renderToStaticMarkup(createElement(AuthProviderDetail, {
    provider,
    rawProviders: authState.providers,
    authPath: authState.authPath,
    error: null,
    onOpenLogin: () => {},
    onSelectAuthChoice: () => {},
    onRemoveAuthProfile: () => {},
    onLogoutProvider: () => {},
    onRefreshAuth: () => {},
  }));

  assert.match(markup, />Sign in</);
  assert.match(markup, />Add key</);
  assert.doesNotMatch(markup, /Saved access/);
  assert.doesNotMatch(markup, /Remove all saved access/);
  assert.doesNotMatch(markup, /max-w-none/);
});

test('saved provider access explains encrypted account synchronization', () => {
  const authState = emptyOpenAiAuthState();
  authState.providers[1] = rawProvider({
    id: 'openai',
    configured: true,
    options: [{
      value: 'profile:key-1',
      label: 'OpenAI key',
      detail: 'Saved API key',
      method: 'API key',
      source: 'Kordi auth',
      active: true,
      profileId: 'key-1',
    }],
  });
  const provider = buildAuthDisplayProviders(authState).find((item) => item.id === 'openai');
  assert.ok(provider);

  const markup = renderToStaticMarkup(createElement(AuthProviderDetail, {
    provider,
    rawProviders: authState.providers,
    authPath: authState.authPath,
    error: null,
    onOpenLogin: () => {},
    onSelectAuthChoice: () => {},
    onRemoveAuthProfile: () => {},
    onLogoutProvider: () => {},
    onRefreshAuth: () => {},
  }));

  assert.match(markup, /encrypted and synced with your Kordi account/);
  assert.match(markup, /updates your other signed-in devices/);
  assert.match(markup, /Environment variables stay on this device/);
});

test('settings provider detail uses one restrained responsive content column', () => {
  const source = readFileSync(new URL('../src/kordi-app/auth/AuthPage.tsx', import.meta.url), 'utf8');
  const columnStart = source.indexOf('data-auth-provider-detail-column');
  const columnEnd = source.indexOf(') : (', columnStart);
  assert.ok(columnStart >= 0 && columnEnd > columnStart, 'expected the Settings detail content column');
  const column = source.slice(columnStart, columnEnd);

  assert.match(column, /w-full/);
  assert.match(column, /min-w-0/);
  assert.match(column, /max-w-3xl/);
  assert.match(column, /\{detailHeader\}[\s\S]*\{content\}/);
  assert.doesNotMatch(column, /max-w-none/);
  assert.doesNotMatch(column, /maxWidth/);
});

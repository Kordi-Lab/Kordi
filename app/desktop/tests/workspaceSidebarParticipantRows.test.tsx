import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { conversation, baseSidebarProps, countMatches } from './helpers/workspaceSidebarParticipantSpacesFixtures';

test('WorkspaceSidebar moves participant-space unread totals between folded parent and unread child sessions', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:one',
      canonicalSessionId: 'session:group:one',
      name: 'First group thread',
      subtitle: 'First unread',
      unread: 2,
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:two',
      canonicalSessionId: 'session:group:two',
      name: 'Second group thread',
      subtitle: 'Second unread',
      unread: 3,
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const [space] = participantSpaces;

  const foldedMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:outside-active',
  }) as never));
  assert.match(foldedMarkup, /data-unread-scope="participant-space"[^>]*data-unread-count="5"/);
  assert.doesNotMatch(foldedMarkup, /data-unread-scope="participant-session"/);

  const expandedMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: space?.id,
    activeConvId: 'session:group:two',
  }) as never));
  assert.doesNotMatch(expandedMarkup, /data-unread-scope="participant-space"/);
  assert.match(expandedMarkup, /data-unread-scope="participant-session"[^>]*data-unread-count="2"/);
  assert.doesNotMatch(expandedMarkup, /data-unread-scope="participant-session"[^>]*data-unread-count="3"/);
});

test('WorkspaceSidebar moves participant-space running light from expanded parent to child session', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:one',
      canonicalSessionId: 'session:group:one',
      name: 'First group thread',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      statusIndicator: { label: 'Processing', tone: 'running', live: true },
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:group:two',
      canonicalSessionId: 'session:group:two',
      name: 'Second group thread',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 1,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const [space] = participantSpaces;

  const foldedMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:outside-active',
  }) as never));
  assert.equal(countMatches(foldedMarkup, /app-session-status-light-running/g), 1);

  const expandedMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: space?.id,
    activeConvId: 'session:group:one',
  }) as never));
  assert.equal(countMatches(expandedMarkup, /app-session-status-light-running/g), 1);
});

test('direct participant-space rows still highlight when their session is active', () => {
  const chatConversations = [
    conversation({
      id: 'session:bob:active',
      canonicalSessionId: 'session:bob:active',
      name: 'Bob',
      subtitle: 'Active direct chat',
      participants: ['Me', 'Bob'],
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    filteredConversations: chatConversations,
    activeConvId: 'session:bob:active',
  }) as never));

  assert.match(
    markup,
    /app-participant-space-row-shell[^"&]*app-session-row-active|app-session-row-active[^"&]*app-participant-space-row-shell/,
    'active direct sessions should apply the active highlight to the full row shell, including the timestamp column',
  );
  assert.match(markup, /app-participant-space-row-shell-selected/, 'active direct session shell should use the selected participant-row style');
  assert.doesNotMatch(
    markup,
    /app-participant-space-row-button[^"&]*app-session-row-active|app-session-row-active[^"&]*app-participant-space-row-button/,
    'active direct session highlight must not be limited to the inner button column',
  );
  assert.equal(countMatches(markup, /app-session-row-active/g), 1, 'only the visible active direct session row should be highlighted');
});

test('participant-space parent rows are not styled as the active session row', () => {
  const source = readFileSync(new URL('../src/pages/workspaceSidebar.contactRows.tsx', import.meta.url), 'utf8');
  const renderStart = source.indexOf('function ParticipantSpaceRow({');
  const renderEnd = source.indexOf('export function ContactSidebarRow', renderStart);
  assert.notEqual(renderStart, -1, 'expected participant-space renderer');
  assert.notEqual(renderEnd, -1, 'expected end of participant-space renderer');
  const renderer = source.slice(renderStart, renderEnd);

  assert.doesNotMatch(
    renderer,
    /app-participant-space-row-shell-active/,
    'participant-space parent shells should not reuse active-session styling',
  );
  assert.match(
    renderer,
    /isExpanded[\s\S]*app-participant-space-row-shell-expanded/,
    'expanded parent rows should use a separate expanded state',
  );
});

test('participant-space parent row primary click selects a session while chevron toggles expansion', () => {
  const source = readFileSync(new URL('../src/pages/workspaceSidebar.contactRows.tsx', import.meta.url), 'utf8');
  const selectHelperStart = source.indexOf('const selectPrimarySession = () => {');
  assert.notEqual(selectHelperStart, -1, 'expected primary parent-row selection helper');
  const selectHelper = source.slice(selectHelperStart, source.indexOf('\n  };', selectHelperStart));
  assert.match(selectHelper, /onSelectChatSession\(primarySession\.id\)/, 'primary parent click should select the latest session in one click');

  const renderStart = source.indexOf('function ParticipantSpaceRow({');
  const renderEnd = source.indexOf('export function ContactSidebarRow', renderStart);
  const renderer = source.slice(renderStart, renderEnd);
  assert.match(renderer, /onClick=\{selectPrimarySession\}/, 'parent row button should select, not toggle');
  assert.match(renderer, /data-participant-space-toggle-button="true"[\s\S]*toggleSpace\(\)/, 'chevron remains the explicit expand-collapse control');
});

test('participant-space row CSS separates the timestamp and actions while adding dense dividers', () => {
  const shellCss = readDesktopShellCss();
  const themeOverrideCss = shellCss;
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  assert.match(shellCss, /\.app-participant-space-row-shell\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) max-content[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(shellCss, /\.app-participant-space-row-actions\s*{[^}]*position:\s*static/s);
  assert.match(shellCss, /\.app-participant-space-row-actions\s*{[^}]*grid-template-columns:\s*repeat\(3, 1\.5rem\)/s);
  assert.match(shellCss, /\.app-participant-space-row-side\s*{[^}]*grid-template-rows:\s*max-content;/s);
  assert.doesNotMatch(shellCss, /\.app-participant-space-row-side\s*{[^}]*grid-template-rows:\s*max-content 1fr/s);
  assert.match(shellCss, /\.app-participant-space-row-side\s*{[^}]*min-height:\s*3\.125rem/s);
  assert.doesNotMatch(shellCss, /\.app-participant-space-row-side\s*{[^}]*min-height:\s*4\.05rem/s);
  assert.match(shellCss, /\.app-participant-space-row-meta\s*{[^}]*align-self:\s*start/s);
  assert.doesNotMatch(shellCss, /\.app-participant-space-row-meta\s*{[^}]*align-self:\s*end/s);
  assert.match(shellCss, /\.app-participant-space-inline-group\s*{[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-participant-space-inline-group-expanded\s*{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-participant-space-row-shell-expanded\s*{[^}]*background:\s*color-mix\(in oklab, var\(--app-sidebar-selected-bg\) 38%, transparent\);[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-participant-space-row-shell-selected\s*{[^}]*background:\s*var\(--app-sidebar-selected-bg\)/s);
  assert.doesNotMatch(shellCss, /\.app-participant-space-row-shell-expanded\s*{[^}]*border-color:\s*color-mix\(in oklab, var\(--app-accent-ring\)/s);
  assert.match(shellCss, /\.app-participant-space-row-button\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/s);
  assert.match(shellCss, /\.app-participant-space-row-button\s*{[^}]*padding:/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-row-button\s*{[^}]*display:\s*grid/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-row-detail\s*{[^}]*color:\s*var\(--app-sidebar-time-text\)/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-row-title\s*{[^}]*color:\s*var\(--app-sidebar-title-text\);[^}]*font-weight:\s*600/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-session-row-title\s*{[^}]*color:\s*var\(--app-sidebar-title-text\);[^}]*font-weight:\s*600/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-session-meta-time\s*{[^}]*color:\s*var\(--app-sidebar-time-text\);[^}]*font-weight:\s*400/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-sidebar-unread-badge\s*{[^}]*background:\s*var\(--app-sidebar-accent\);[^}]*color:\s*var\(--app-sidebar-accent-text\);[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-session-row\s*{[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-session-row\s*{[^}]*border-radius:\s*0;/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-filter-tab-active\s*{[^}]*background:\s*var\(--app-sidebar-selected-bg\);[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-session-row:hover\s*{[^}]*background:\s*color-mix\(in oklab, var\(--app-sidebar-selected-bg\) 72%, transparent\)/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\s*{[^}]*min-height:\s*2\.875rem;[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-preview\s*{[^}]*color:\s*var\(--app-sidebar-preview-text\)/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\.app-session-row-active\s*{[^}]*background:\s*var\(--app-sidebar-selected-bg\);[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\.app-session-row-active\s*{[^}]*0 8px 18px/s);
  assert.match(shellCss, /\.app-participant-space-inline-group:not\(\.app-participant-space-inline-group-expanded\) \.app-participant-space-row-actions\s*{[^}]*opacity:\s*0\.46/s);
  assert.match(themeTokensCss, /\.kordi-app\s*{[^}]*--app-sidebar-title-text:\s*rgb\(248 250 252\);[^}]*--app-sidebar-preview-text:\s*rgb\(148 163 184\);[^}]*--app-sidebar-time-text:\s*rgb\(100 116 139\);[^}]*--app-sidebar-accent:\s*#60A5FA;[^}]*--app-sidebar-selected-bg:\s*rgba\(37, 99, 235, 0\.18\);/s);
  assert.match(themeTokensCss, /\.kordi-app\.theme-light\s*{[^}]*--app-sidebar-title-text:\s*#111827;[^}]*--app-sidebar-preview-text:\s*#6B7280;[^}]*--app-sidebar-time-text:\s*#9CA3AF;[^}]*--app-sidebar-accent:\s*#2563EB;[^}]*--app-sidebar-selected-bg:\s*#EEF4FF;/s);
  assert.match(themeOverrideCss, /\.kordi-app\.theme-light \.app-session-row-active\s*{[^}]*background:\s*var\(--app-sidebar-selected-bg\);[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(themeOverrideCss, /\.kordi-app\.theme-light \.app-workspace-sidebar \.app-session-row-active,[\s\S]*?\{\s*box-shadow:\s*none;/s);
});

test('Bridge sync status CSS distinguishes syncing and unavailable icon states', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-collaboration-sync-status\[data-collaboration-sync-status="syncing"\]\s*{[^}]*color:\s*oklch\(74% 0\.045 174\)/s);
  assert.match(shellCss, /\.app-collaboration-sync-status\[data-collaboration-sync-status="unavailable"\]\s*{[^}]*color:\s*oklch\(72% 0\.16 25\)/s);
  assert.match(shellCss, /\.app-collaboration-sync-arc\s*{[^}]*animation:\s*app-collaboration-sync-orbit 900ms linear infinite/s);
  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)\s*{[^}]*\.app-collaboration-sync-arc\s*{[^}]*animation:\s*none/s);
});

test('WorkspaceSidebar labels human-centered and self spaces clearly', () => {
  const chatConversations = [
    conversation({
      id: 'session:taylor-agent',
      canonicalSessionId: 'session:taylor-agent',
      name: 'Agent-assisted chat with taylor',
      subtitle: "taylor2's Kordi joined via mention",
      participants: ['Me', 'taylor', "taylor2's Kordi"],
      _updatedAtMs: 3,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:taylor', name: 'taylor', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'taylor' },
        { id: 'agent:taylor2-kordi', name: "taylor2's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'agent-taylor' },
      ],
    }),
    conversation({
      id: 'session:my-kordi',
      canonicalSessionId: 'session:my-kordi',
      name: 'Planning with My Kordi',
      type: 'owned-agent',
      subtitle: 'Sketch the plan',
      participants: ['Me', 'My Kordi'],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-kordi', name: 'My Kordi', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-kordi' },
      ],
    }),
    conversation({
      id: 'session:remote-agent',
      canonicalSessionId: 'session:remote-agent',
      name: 'Ask Research Kordi',
      type: 'external-agent',
      subtitle: 'Find references',
      participants: ['Me', 'Research Kordi'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:research-kordi', name: 'Research Kordi', kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'research-kordi' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:taylor-agent',
  }) as never));

  assert.match(markup, /taylor/);
  assert.doesNotMatch(markup, /Person • 1 chat/);
  assert.match(markup, /My chats/);
  assert.match(markup, /Personal • 2 sessions/);
  assert.doesNotMatch(markup, /Person \+ 1 agent/);
  assert.doesNotMatch(markup, /Myself \+ 2 agents/);
  assert.doesNotMatch(markup, /Group • 1 session/);
});

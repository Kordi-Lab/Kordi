import { StrictMode, useLayoutEffect, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';

import { normalizeContactProfile } from '../../src/features/cloud/contactProfileClient';
import { ChatPersonInfo } from '../../src/kordi-app/contacts/ChatPersonInfo';
import type { Contact, Conversation } from '../../src/kordi-app/types';
import { SessionDestinationTabs } from '../../src/pages/chatsPage.destinations';
import { RightDetailRail } from '../../src/pages/RightDetailRail';
import { contactSharedVisualMessages } from './contactSharedFixtures';
import '../../src/index.css';

// Login-free preview of the Info tab of a direct person chat with fictional people.
// Query params: ?theme=light|dark, ?page=photos|files|links (that shared page opens in the tab),
// ?offline=1 (the other person was last seen yesterday).
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const sharedPage = ({ photos: 'Photos', files: 'Files', links: 'Links' } as Record<string, string>)[params.get('page') ?? ''];
const offline = params.get('offline') === '1';
localStorage.setItem('kordi.themeMode.v1', theme);

function yesterdayAt(hours: number, minutes: number) {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function initialsAvatar(name: string, fill: string) {
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="${fill}"/>`
    + `<text x="40" y="40" dy="0.35em" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="32" font-weight="600" fill="#fff">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const MAYA: Contact = {
  id: 'cloud:acct_maya', name: 'Maya Chen', initials: 'MC', classType: 'other-users', entityType: 'user',
  subtitle: '@482731906', collaborationSources: ['Cloud'], status: 'Available', discoverableOn: [], detail: '@482731906',
  owner: 'Maya Chen', sourceHostId: 'cloud', sourceParticipantId: 'acct_maya', avatarSeed: 'acct_maya',
  profileImageUrl: initialsAvatar('Maya Chen', '#d9627f'),
  presenceStatus: offline ? 'offline' : 'online', presenceLastSeenAt: offline ? yesterdayAt(20, 28) : null,
};

const PROFILE = normalizeContactProfile({
  accountId: 'acct_maya', kordiId: '482731906', displayName: 'Maya Chen', kind: 'person',
  shared: { mediaCount: 7, linkCount: 3, documentCount: 2, groups: [{ groupId: 'gs_reading', title: 'Reading group', avatarUrl: null }, { groupId: 'gs_lab', title: 'Lab', avatarUrl: null }] },
})!;

const CHAT: Conversation = {
  id: 'session:direct-person:acct_maya:acct_preview', canonicalSessionId: 'session:direct-person:acct_maya:acct_preview',
  name: 'Maya Chen', type: 'person', subtitle: '', unread: 0, collaborationSources: ['Cloud'], trust: '', directness: '',
  participants: ['Me', 'Maya Chen'], messages: contactSharedVisualMessages(),
};

// The chat pane's spacing tokens, as the split workspace sets them in the app.
const CHAT_PANE_VARS = {
  '--app-chat-pane-header-inline': '1rem',
  '--app-chat-pane-tab-height': '2.125rem',
  '--app-chat-pane-tab-inline': '10px',
  '--app-chat-pane-detail-top': '0.75rem',
  '--app-chat-pane-detail-inline': 'clamp(1.25rem, 4vw, 2.75rem)',
} as CSSProperties;

function ChatInfoPreview() {
  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    if (!sharedPage) return undefined;
    const timer = setTimeout(() => {
      const rows = document.querySelectorAll<HTMLButtonElement>('.app-chat-person-info button');
      [...rows].find((row) => row.textContent?.trim().startsWith(sharedPage))?.click();
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={`kordi-app theme-${theme} flex h-screen w-screen`} style={{ background: 'var(--app-main-bg)', color: 'var(--utility-foreground)', ...CHAT_PANE_VARS }}>
      <aside className="w-[280px] shrink-0 border-r border-[color:var(--app-divider)]" style={{ background: 'var(--app-sidebar-bg)' }} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative h-[52px] shrink-0 border-b border-[color:var(--app-divider)]">
          <SessionDestinationTabs scope="main" activeDestination="info" onSelect={() => undefined} />
        </div>
        <div className="min-h-0 flex-1">
          <RightDetailRail
            detailTabs={[{ id: 'info', label: 'Info' }]}
            activeDetailTab="info"
            onSelectDetailTab={() => undefined}
            activeSourcePreview={null}
            onCloseSourcePreview={() => undefined}
            variant="page"
          >
            <ChatPersonInfo
              peer={MAYA}
              self={{ id: 'acct_preview', name: 'Alex Rivera', imageUrl: initialsAvatar('Alex Rivera', '#2563eb') }}
              conversation={CHAT}
              host={{ accountIdFor: (contact) => contact.sourceParticipantId ?? null, load: async () => PROFILE, openGroup: () => undefined }}
              onOpenPeer={() => { document.body.dataset.openedProfile = 'acct_maya'; }}
              onReturnToChat={() => undefined}
            />
          </RightDetailRail>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><ChatInfoPreview /></StrictMode>);

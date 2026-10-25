import { useState } from 'react';
import { WorkspaceNavigationRail } from '../../src/pages/workspaceSidebar.navigation';
import { ChatSidebarChrome } from '../../src/pages/workspaceSidebar.chrome';
import { ContactsPage } from '../../src/kordi-app/contacts/ContactsPage';
import { CommonGroundContactsRow } from '../../src/features/commonGround/CommonGroundContactsRow';
import { settingsSections, type SettingsSectionId } from '../../src/kordi-app/data/settings';
import type { CloudAccount } from '../../src/features/cloud/authClient';
import type { CloudAccountSettingsTabId } from '../../src/pages/CloudAccountSettingsDialog';
import type { Contact, NavId, ThemeMode } from '../../src/kordi-app/types';
import type { WorkspaceSidebarAccount } from '../../src/pages/workspaceSidebar.types';
import { navItems } from '../../src/kordi-app/data';

const noop = () => {};
const resolved = async () => {};
const account: CloudAccount = {
  accountId: 'acct_help_preview', displayName: 'Taylor Preview', primaryEmail: 'taylor@example.test',
  primaryEmailVerified: true, nodeId: 'node-help-preview', passwordSet: false,
  kordiId: '517309264', accountNumber: '517309264', kordiIdChangeAvailableAt: null,
  about: '', location: null, timeZone: null, website: null, birthday: null, avatarUrl: null,
  avatar: { entityType: 'human', entityId: 'acct_help_preview', source: 'generated', style: 'lorelei', seed: 'help-preview', rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0', uploadedAsset: null, version: 1, updatedAt: '2026-10-01T00:00:00Z' },
};
const people: Contact[] = ['Maya Chen', 'Ethan Park', 'Priya Shah'].map((name, index) => ({
  id: `help-person-${index}`, name, initials: name.split(' ').map((part) => part[0]).join(''),
  classType: 'other-users', entityType: 'user', subtitle: 'Kordi contact', collaborationSources: ['Cloud'],
  status: 'Available', discoverableOn: [], detail: '', owner: name,
}));

/** Actual navigation, account settings, and Contacts components with fictional local data. */
export function HelpWorkspacePreview({ theme }: { theme: 'dark' | 'light' }) {
  const [activeNav, setActiveNav] = useState<NavId>('contacts');
  const [tab, setTab] = useState<CloudAccountSettingsTabId | null>(null);
  const [section, setSection] = useState<SettingsSectionId>('auth');
  const [themeMode, setThemeMode] = useState<ThemeMode>(theme);
  const [search, setSearch] = useState('');
  const [person, setPerson] = useState('');
  const [draft, setDraft] = useState('');
  const sidebarAccount: WorkspaceSidebarAccount = {
    cloudAccount: account, cloudAccountDialogTab: tab, setCloudAccountDialogTab: setTab,
    onUpdateCloudProfile: resolved,
    cloudSettings: {
      settingsSections, activeSettingsSectionId: section, setActiveSettingsSectionId: setSection,
      authSettingsLayoutWidth: 620, isNativeShell: true, desktopAuthState: { authPath: '', hasAnyAuth: false, providers: [] },
      isDesktopAuthLoading: false, desktopAuthError: null, activeLoginProviderId: null,
      selectAuthProvider: noop, openLoginFlow: noop, refreshDesktopAuth: resolved,
      handleSelectAuthChoice: resolved, handleRemoveAuthProfile: resolved, handleLogoutProvider: resolved,
      themeMode, setThemeMode,
    },
  };
  return <div className={`kordi-app theme-${themeMode} app-cloud-workspace-surface`} style={{ display: 'flex', height: '100dvh', background: 'var(--app-page-bg)' }}>
    <WorkspaceNavigationRail isNativeShell={false} activeNav={activeNav} setActiveNav={setActiveNav} agentUnread={0} contactUnread={0} pendingContactRequestCount={0} account={sidebarAccount} updater={{}} onOpenSession={noop} />
    <main className="app-main-panel" style={{ display: 'flex', flex: 1, minWidth: 0, position: 'relative' }}>
      {activeNav === 'contacts' ? <ContactsPage
        filteredGroupedContacts={[{ id: 'other-users', label: 'Contacts', items: people.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())) }]}
        isContactRequestsOpen={false} onToggleRequests={noop} contactRequests={[]} activeContactRequestId=""
        contactSearch={search} onContactSearchChange={setSearch} expandedContactGroups={{ 'other-users': true, 'my-agents': true, 'other-users-agents': true }} onToggleGroup={noop}
        activeContactId={person} onSelectContact={(_group, id) => setPerson(id)} contactOverlayMode={person ? 'contact' : null} activeContact={people.find((item) => item.id === person) ?? people[0]}
        onCloseOverlay={() => setPerson('')} getStatusBadgeClass={() => ''}
        leadingListItems={<CommonGroundContactsRow selected={false} onSelect={noop} />}
      /> : <>
        {(activeNav === 'chats' || activeNav === 'agent-chats') ? <aside className="app-side-shell" style={{ width: 260, padding: 12 }}><ChatSidebarChrome chatChannel={activeNav === 'chats' ? 'contact' : 'agent'} chatSearch={search} setChatSearch={setSearch} collaborationSyncAriaLabel={null} collaborationSyncStatus="idle" onOpenCreate={noop} />{people.map((item) => <div className="app-contact-row" key={item.id} style={{ padding: '16px 8px', fontSize: 13 }}>{item.name}</div>)}</aside> : null}
        <section style={{ flex: 1, padding: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>{navItems.find((item) => item.id === activeNav)?.label}</h1>
          <p style={{ fontSize: 13, opacity: .6 }}>Offline preview · Sample workspace</p>
          <div style={{ flex: 1 }} />
          {(activeNav === 'chats' || activeNav === 'agent-chats') ? <textarea aria-label="Message draft" className="app-composer-shell" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message" style={{ padding: 16 }} /> : null}
        </section>
      </>}
      <span style={{ position: 'absolute', right: 20, bottom: 14, fontSize: 11, opacity: .45, pointerEvents: 'none' }}>Offline preview · Sample data</span>
    </main>
  </div>;
}

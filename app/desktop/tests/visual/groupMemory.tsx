// Login-free synthetic preview of the real group info popover on its Memory
// view (`?view=members` opens the member grid instead). The group's id matches
// the preview memory client's group memory, so the view lists that memory. It
// makes no network calls and needs no session.
import { createRoot } from 'react-dom/client';

import { buildParticipantSpaces } from '../../src/features/chat/participantSpaces';
import { PREVIEW_GROUP_MEMORY_SCOPE_ID, createPreviewMemoryClient } from '../../src/features/memory/memoryClient';
import { GroupDetailsDialog } from '../../src/pages/GroupDetailsDialog';
import { conversation } from '../helpers/workspaceSidebarParticipantSpacesFixtures';

const params = new URLSearchParams(window.location.search);
const requestedTheme = params.get('theme');
const initialView = params.get('view') === 'members' ? 'members' : 'memory';
const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
const theme: 'light' | 'dark' = requestedTheme === 'light' || requestedTheme === 'dark'
  ? requestedTheme
  : prefersLight ? 'light' : 'dark';

document.body.classList.toggle('theme-light', theme === 'light');
document.body.classList.toggle('theme-dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

const groupSessionId = `session:group:${PREVIEW_GROUP_MEMORY_SCOPE_ID}`;
const [space] = buildParticipantSpaces([conversation({
  id: groupSessionId,
  canonicalSessionId: groupSessionId,
  name: 'Design review',
  metadata: {
    customName: 'Design review',
    groupSpaceId: groupSessionId,
    groupCreatorIdentityId: 'human:me',
    adminIdentityIds: ['human:me'],
  },
  participants: ['Me', 'Maya Chen', 'Ethan Park', 'Tom Cohen'],
  canonicalParticipants: [
    { id: 'human:me', humanId: 'acct_preview_self', name: 'Me', kind: 'human', role: 'self', source: 'cloud', avatarKey: 'me' },
    { id: 'human:maya', humanId: 'acct_maya', name: 'Maya Chen', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'maya' },
    { id: 'human:ethan', humanId: 'acct_ethan', name: 'Ethan Park', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'ethan' },
    { id: 'human:tom', humanId: 'acct_tom', name: 'Tom Cohen', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'tom' },
  ],
})]);

const memoryClient = createPreviewMemoryClient();
const noop = () => undefined;

createRoot(document.getElementById('root')!).render(
  <main className={`kordi-app theme-${theme} group-invitation-visual-shell`}>
    <aside className="group-invitation-visual-sidebar" aria-hidden="true" />
    <section className="group-invitation-visual-workspace" aria-hidden="true" />
    <GroupDetailsDialog
      isOpen
      space={space}
      contacts={[]}
      currentAccountId="acct_preview_self"
      // The preview is the popover, so closing keeps it open.
      onClose={noop}
      onRename={noop}
      onAddMembers={noop}
      onRemoveMember={noop}
      onSetAdmin={noop}
      anchorRect={{ left: 220, top: 96, width: 260, height: 56 }}
      memoryClient={memoryClient}
      initialView={initialView}
    />
  </main>,
);

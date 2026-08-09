import { createRoot } from 'react-dom/client';

import { buildParticipantSpaces } from '../../src/features/chat/participantSpaces';
import { GroupDetailsDialog } from '../../src/pages/GroupDetailsDialog';
import { GroupInvitationDialog } from '../../src/pages/GroupInvitationDialog';
import { conversation } from '../helpers/workspaceSidebarParticipantSpacesFixtures';

const theme = new URLSearchParams(window.location.search).get('theme') === 'dark'
  ? 'dark'
  : 'light';
const requestedMode = new URLSearchParams(window.location.search).get('mode');
const mode = requestedMode === 'recipient' || requestedMode === 'nonadmin' || requestedMode === 'active'
  ? requestedMode
  : 'admin';
const [space] = buildParticipantSpaces([conversation({
  id: 'session:group:invitation-visual',
  canonicalSessionId: 'session:group:invitation-visual',
  name: 'Product Team',
  metadata: {
    customName: 'Product Team',
    groupSpaceId: 'session:group:invitation-visual',
    groupCreatorIdentityId: mode === 'nonadmin' ? 'human:jiaxin' : 'human:me',
    adminIdentityIds: [mode === 'nonadmin' ? 'human:jiaxin' : 'human:me'],
  },
  participants: ['Me', 'Jiaxin Pei', 'Shenzhe Zhu', 'C UFishAI', 'Tom Cohen'],
  canonicalParticipants: [
    { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
    { id: 'human:jiaxin', name: 'Jiaxin Pei', kind: 'human', role: mode === 'nonadmin' ? 'admin' : 'person', source: 'bridge', avatarKey: 'jiaxin' },
    { id: 'human:shenzhe', name: 'Shenzhe Zhu', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shenzhe' },
    { id: 'human:ufish', name: 'C UFishAI', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'ufish' },
    { id: 'human:tom', name: 'Tom Cohen', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'tom' },
  ],
})]);

document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;

createRoot(document.querySelector('#root')!).render(
  <main className={`kordi-app theme-${theme} group-invitation-visual-shell`}>
    <aside className="group-invitation-visual-sidebar" aria-hidden="true" />
    <section className="group-invitation-visual-workspace" aria-hidden="true" />
    {mode !== 'recipient' ? (
      <GroupDetailsDialog
        isOpen
        space={space}
        contacts={[]}
        onClose={() => undefined}
        onRename={() => undefined}
        onAddMembers={() => undefined}
        onRemoveMember={() => undefined}
        onSetAdmin={() => undefined}
        anchorRect={{ left: 220, top: 140, width: 260, height: 56 }}
        onCreateGroupInvitation={async () => ({
          invitationId: 'groupinv_visual',
          inviteUrl: `https://kordi.ai/g/kordi_gi_${'a'.repeat(43)}`,
          expiresAt: '2026-08-15T00:00:00Z',
        })}
        onListGroupInvitations={mode === 'active' ? async () => ([{
          invitationId: 'groupinv_active_visual',
          expiresAt: '2026-08-15T00:00:00Z',
        }]) : undefined}
        onRevokeGroupInvitation={async () => undefined}
      />
    ) : (
      <GroupInvitationDialog
        invitationToken={`kordi_gi_${'a'.repeat(43)}`}
        onDismiss={() => undefined}
        onJoined={() => undefined}
      />
    )}
  </main>,
);

document.body.dataset.visualReady = 'true';

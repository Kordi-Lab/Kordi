import { createRoot } from 'react-dom/client';

import { buildParticipantSpaces } from '../../src/features/chat/participantSpaces';
import { CloudCallProvider } from '../../src/features/cloud/CloudCallProvider';
import type { CloudCallsController } from '../../src/features/cloud/cloudCallController';
import { cloudCallTargetForConversation } from '../../src/features/cloud/cloudCalls';
import { GroupDetailsDialog } from '../../src/pages/GroupDetailsDialog';
import { GroupInvitationDialog } from '../../src/pages/GroupInvitationDialog';
import { ContactInfoPopover } from '../../src/pages/ContactInfoPopover';
import { contact, conversation } from '../helpers/workspaceSidebarParticipantSpacesFixtures';

const theme = new URLSearchParams(window.location.search).get('theme') === 'dark'
  ? 'dark'
  : 'light';
const requestedMode = new URLSearchParams(window.location.search).get('mode');
const mode = requestedMode === 'recipient'
  || requestedMode === 'nonadmin'
  || requestedMode === 'active'
  || requestedMode === 'contact'
  ? requestedMode
  : 'admin';
const visualAccount = {
  accountId: 'acct_visual_self',
  displayName: 'Me',
  primaryEmail: 'visual@example.com',
  avatarUrl: null,
  nodeId: null,
  passwordSet: true,
};
const visualCallController: CloudCallsController = {
  account: visualAccount,
  callsBySessionId: {},
  currentCall: null,
  incomingCall: null,
  handoffCall: null,
  phase: 'idle',
  error: null,
  isPresented: false,
  isMicrophoneEnabled: true,
  isCameraEnabled: false,
  isAudioPlaybackBlocked: false,
  connectedAtMs: null,
  mediaParticipants: [],
  mediaDevices: [],
  activeDeviceIds: {},
  canSelectAudioOutput: false,
  targetForConversation: (targetConversation) => (
    cloudCallTargetForConversation(visualAccount, targetConversation)
  ),
  callForConversation: () => null,
  start: async () => undefined,
  join: async () => undefined,
  decline: async () => undefined,
  leave: async () => undefined,
  end: async () => undefined,
  invite: async () => undefined,
  toggleMicrophone: async () => undefined,
  toggleCamera: async () => undefined,
  resumeAudio: async () => undefined,
  refreshMediaDevices: async () => undefined,
  switchMediaDevice: async () => undefined,
  show: () => undefined,
  minimize: () => undefined,
  dismissError: () => undefined,
};
const [space] = buildParticipantSpaces([conversation({
  id: 'session:group:invitation-visual',
  canonicalSessionId: 'session:group:invitation-visual',
  name: 'Product Team',
  metadata: {
    customName: 'Product Team',
    groupSpaceId: 'session:group:invitation-visual',
    groupCreatorIdentityId: mode === 'nonadmin' ? 'human:maya' : 'human:me',
    adminIdentityIds: [mode === 'nonadmin' ? 'human:maya' : 'human:me'],
  },
  participants: ['Me', 'Maya Chen', 'Ethan Park', 'Research Agent', 'Tom Cohen'],
  canonicalParticipants: [
    { id: 'human:me', humanId: 'acct_visual_self', name: 'Me', kind: 'human', role: 'self', source: 'cloud', avatarKey: 'me' },
    { id: 'human:maya', humanId: 'acct_maya', name: 'Maya Chen', kind: 'human', role: mode === 'nonadmin' ? 'admin' : 'person', source: 'cloud', avatarKey: 'maya' },
    { id: 'human:ethan', humanId: 'acct_ethan', name: 'Ethan Park', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'ethan' },
    { id: 'human:research', humanId: 'acct_research', name: 'Research Agent', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'research' },
    { id: 'human:tom', humanId: 'acct_tom', name: 'Tom Cohen', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'tom' },
  ],
})]);

document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;

createRoot(document.querySelector('#root')!).render(
  <CloudCallProvider controller={visualCallController}>
    <main className={`kordi-app theme-${theme} group-invitation-visual-shell`}>
    <aside className="group-invitation-visual-sidebar" aria-hidden="true" />
    <section className="group-invitation-visual-workspace" aria-hidden="true" />
    {mode === 'contact' ? (
      <ContactInfoPopover
        participant={{
          id: 'human:maya',
          kordiId: '482731906',
          humanId: 'acct_maya',
          sourceIdentityId: 'acct_maya',
          name: 'Maya Chen',
          kind: 'human',
          role: 'person',
          source: 'cloud',
          avatarKey: 'maya-chen',
          presenceStatus: 'online',
        }}
        contacts={[contact({
          id: 'cloud:acct_maya',
          name: 'Maya Chen',
          sourceParticipantId: 'acct_maya',
          sourceHumanId: 'acct_maya',
          contactStatus: 'accepted',
          detail: '@482731906',
          presenceStatus: 'online',
        })]}
        conversation={conversation({
          id: 'session:direct-person:acct_maya:acct_visual_self',
          canonicalSessionId: 'session:direct-person:acct_maya:acct_visual_self',
          name: 'Maya Chen',
          participants: ['Me', 'Maya Chen'],
          canonicalParticipants: [
            { id: 'human:me', humanId: 'acct_visual_self', name: 'Me', kind: 'human', role: 'self', source: 'cloud' },
            { id: 'human:maya', humanId: 'acct_maya', name: 'Maya Chen', kind: 'human', role: 'person', source: 'cloud' },
          ],
          messages: [
            {
              role: 'person',
              sender: 'Maya Chen',
              text: 'Here is the launch brief https://example.com/launch',
              time: '10:24',
              attachments: [
                { kind: 'image', name: 'launch-board.png' },
                { kind: 'image', name: 'flow.png' },
              ],
            },
            {
              role: 'user',
              sender: 'Me',
              text: 'I also attached the notes.',
              time: '10:28',
              attachments: [
                { kind: 'file', name: 'demo.mov', mimeType: 'video/quicktime' },
                { kind: 'file', name: 'notes.pdf', mimeType: 'application/pdf' },
              ],
            },
          ],
        })}
        commonGroups={[space]}
        presenceStatus="online"
        anchorRect={{ left: 220, right: 256, top: 120, bottom: 156, width: 36, height: 36 }}
        onClose={() => undefined}
        onMessageContact={() => undefined}
        onOpenCommonGroup={(commonGroup) => {
          document.body.dataset.openedCommonGroup = commonGroup.id;
        }}
      />
    ) : mode !== 'recipient' ? (
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
    </main>
  </CloudCallProvider>,
);

document.body.dataset.visualReady = 'true';

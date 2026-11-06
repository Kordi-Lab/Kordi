import './previewChatTheme';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import HelpMenu from '../../src/features/onboarding/HelpMenu';
import { setAccountOrganizations } from '../../src/features/organizations/organizationStore';
import { PersonalAgentSessionMenu } from '../../src/features/personalAgent/PersonalAgentSessionMenu';
import { ComposerModelControls } from '../../src/kordi-app/components/composer';
import { ComposerAttachmentAddMenu } from '../../src/kordi-app/components/composerAttachments';
import { MessageContextMenuContent } from '../../src/kordi-app/components/messageContextMenuContent';
import { AttachmentContextMenu } from '../../src/kordi-app/components/transcriptAttachmentContextMenu';
import type { Message, MessageAttachment } from '../../src/kordi-app/types';
import { GroupContextMenu, SessionContextMenu } from '../../src/pages/SessionActionOverlays';
import { SidebarProfileControl } from '../../src/pages/workspaceSidebar.profile';
import type { WorkspaceSidebarAccount } from '../../src/pages/workspaceSidebar.types';

// Synthetic data only: every pop-up menu of the app open at once, beside the
// Help menu they follow. ?theme=light|dark
const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;

const noop = () => {};
const accountId = 'preview-account';
const cloudAccount = {
  accountId, kordiId: 'avery', displayName: 'Avery Stone', primaryEmail: null, avatarUrl: null,
  avatar: { kind: 'generated', seed: 'avery-preview' },
} as unknown as NonNullable<WorkspaceSidebarAccount['cloudAccount']>;
const accountProps: WorkspaceSidebarAccount = {
  cloudAccount,
  cloudSettings: {} as NonNullable<WorkspaceSidebarAccount['cloudSettings']>,
  onUpdateCloudProfile: async () => {},
  onCreateAppInvite: async () => 'https://kordi.ai/i/preview',
};
const organizations = [
  { organizationId: 'org-personal', name: 'Personal', kind: 'personal', role: 'owner', memberCount: 1 },
  { organizationId: 'org-team', name: 'Northwind Studio', kind: 'team', role: 'member', memberCount: 12 },
] as Parameters<typeof setAccountOrganizations>[1];

const message = {
  id: 'msg-preview', role: 'person', senderType: 'human', sender: 'Maya Chen', text: 'The draft is ready for review.', time: '09:41',
  reactionConversationId: 'conversation-preview', reactionTargetMessageId: 'target-preview',
} as Message;
const image = { id: 'att-preview', attachmentId: 'att-preview', kind: 'image', name: 'whiteboard.png', mimeType: 'image/png' } as unknown as MessageAttachment;
const models = [
  { value: 'openai/gpt-6-sol', label: 'gpt-6-sol', provider: 'openai', thinkingLevels: ['low', 'medium', 'high'] },
  { value: 'openai/gpt-5.6-sol', label: 'gpt-5.6-sol', provider: 'openai', thinkingLevels: ['low', 'medium', 'high'] },
];
const providers = [{ value: 'openai::work', providerId: 'openai', label: 'ChatGPT', detail: 'Work', selectionLabel: 'ChatGPT · Work' }];

/** A labelled slot; pop-ups that position themselves read their anchor from it. */
function Slot({ name, label, style, children }: { name: string; label: string; style: React.CSSProperties; children?: ReactNode }) {
  return <section data-gallery={name} style={{ position: 'absolute', ...style }}>
    <h3 style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 500, opacity: 0.55 }}>{label}</h3>
    {children}
  </section>;
}

/** Opens a pop-up by clicking its trigger once, without a pointer press that would close the others. */
function useClickOnMount(selector: string, delay = 60, last = false) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const matches = document.querySelectorAll<HTMLElement>(selector);
      matches[last ? matches.length - 1 : 0]?.click();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [selector, delay, last]);
}

function Fixture() {
  const helpAnchor = { left: 12, top: 900, width: 1, height: 1 };
  const [ready, setReady] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setAccountOrganizations(accountId, organizations, null);
    const timer = window.setTimeout(() => setReady(true), 400);
    return () => window.clearTimeout(timer);
  }, []);
  useClickOnMount('[data-gallery="account"] .app-nav-rail-profile');
  useClickOnMount('[data-gallery="organizations"] .app-nav-rail-profile', 120);
  // The second account menu opens later, so its organization row is the last one.
  useClickOnMount('[data-organization-id][aria-haspopup="menu"]', 240, true);
  useClickOnMount('[data-gallery="composer-add"] [data-composer-attachment-add-trigger]');
  useClickOnMount('[data-gallery="model"] .app-model-effort-pill > button');

  return <div className={`kordi-app theme-${theme} app-cloud-workspace-surface`} data-gallery-ready={ready || undefined}
    style={{ position: 'relative', minHeight: '100dvh', background: 'var(--app-page-bg)', color: 'var(--utility-foreground)', fontSize: 13 }}>
    <Slot name="help" label="Help (reference)" style={{ left: 20, top: 600 }} />
    <HelpMenu anchor={helpAnchor} progressKey="popover-gallery" settingsAvailable supportAvailable onAction={noop} onOpenSession={noop} onStartTour={noop} onDismiss={noop} />

    <Slot name="session" label="Chat actions" style={{ left: 300, top: 16 }}>
      <SessionContextMenu target={{ sessionId: 's1', sessionName: 'Launch plan', x: 300, y: 40, canRename: true, canChooseProject: true }}
        onClose={noop} onRename={noop} onArchive={noop} onRestore={noop} onSetPinned={noop} onSetMuted={noop} onSetUnread={noop} onDelete={noop} />
    </Slot>
    <Slot name="group" label="Group actions" style={{ left: 560, top: 16 }}>
      <GroupContextMenu target={{ groupSpaceId: 'g1', groupName: 'Design review', sessionIds: ['s2'], x: 560, y: 40 }}
        onClose={noop} onSetPinned={noop} onSetMuted={noop} onMarkRead={noop} onArchive={noop} onRestore={noop} />
    </Slot>
    <Slot name="personal" label="Personal agent chat" style={{ left: 820, top: 16 }}>
      <PersonalAgentSessionMenu target={{ sessionId: 's3', sessionName: 'Kordi', x: 820, y: 40, personalAgent: { agentId: 'a1', localAgentId: 'local-a1' } }}
        onClose={noop} onSetMuted={noop} onSetUnread={noop} onOpenAgentSettings={noop} />
    </Slot>
    <Slot name="attachment" label="Image actions" style={{ left: 1080, top: 16 }}>
      <AttachmentContextMenu state={{ attachment: image, x: 1080, y: 40 }} onClose={noop} />
    </Slot>
    <Slot name="message" label="Message actions" style={{ left: 1320, top: 16 }}>
      <MessageContextMenuContent msg={message} onClose={noop} onReplyMessage={noop} onOpenMessageThread={noop} onForwardMessage={noop}
        onEditMessage={noop} onDeleteMessage={noop} onSelectMessage={noop} onRequestPinMessage={noop} onReactMessage={noop} />
    </Slot>

    <Slot name="account" label="Account" style={{ left: 300, top: 600 }}>
      <div style={{ position: 'fixed', left: 300, top: 930 }}><SidebarProfileControl {...accountProps} /></div>
    </Slot>
    <Slot name="organizations" label="Organizations" style={{ left: 640, top: 600 }}>
      <div style={{ position: 'fixed', left: 640, top: 930 }}><SidebarProfileControl {...accountProps} /></div>
    </Slot>
    <Slot name="composer-add" label="Composer +" style={{ left: 960, top: 600 }}>
      <div className="app-composer-shell" style={{ position: 'fixed', left: 960, top: 930, width: 220, padding: 4, borderRadius: 20 }}>
        <input ref={fileInput} type="file" hidden />
        <ComposerAttachmentAddMenu inputRef={fileInput} onRecordVideo={noop} />
      </div>
    </Slot>
    <Slot name="model" label="Model" style={{ left: 1290, top: 600 }}>
      <div style={{ position: 'fixed', left: 1460, top: 940 }}>
        <ComposerModelControls scope="chat" selection={{ mode: 'agent', model: models[0].value, thinking: 'medium', authProvider: 'openai', authChoice: 'work' }}
          openSelector={null} onToggleSelector={noop} onSelectValue={noop} authLabel="Synthetic account" authOptions={[]} onSelectAuthChoice={noop}
          onSelectProviderChoice={noop} providerOptions={providers} modelOptions={models} />
      </div>
    </Slot>
  </div>;
}

createRoot(document.querySelector('#root')!).render(<Fixture />);

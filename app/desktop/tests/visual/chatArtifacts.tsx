// Login-free synthetic preview of a chat's Artifacts tab beside its Memory tab:
// the real destination tabs, detail page, Artifacts panel, and memory list.
// `?tab=memory` opens the Memory tab, and `?empty=1` previews a chat without
// artifacts or memories. It makes no network calls and needs no session.
import './previewChatTheme';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { DocumentReaderHostContext, type DocumentReaderHost } from '../../src/features/documents/documentReaderHost';
import { publishMemoryVersion } from '../../src/features/memory/memoryAvailability';
import { PREVIEW_CONVERSATION_MEMORY_SCOPE_ID, createPreviewMemoryClient } from '../../src/features/memory/memoryClient';
import type { Conversation, SessionArtifact } from '../../src/kordi-app/types';
import { ChatDetailPanel } from '../../src/pages/ChatDetailPanel';
import { ChatMemoryTab } from '../../src/pages/ChatMemoryTab';
import { RightDetailRail } from '../../src/pages/RightDetailRail';
import { SessionDestinationTabs } from '../../src/pages/chatsPage.destinations';
import { CHAT_DETAIL_TABS } from '../../src/pages/chatsPage.destinationModel';

const params = new URLSearchParams(window.location.search);
const requestedTheme = params.get('theme');
const empty = params.has('empty');
const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
const theme: 'light' | 'dark' = requestedTheme === 'light' || requestedTheme === 'dark'
  ? requestedTheme
  : prefersLight ? 'light' : 'dark';

document.body.classList.toggle('theme-light', theme === 'light');
document.body.classList.toggle('theme-dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

// The preview stands in for a server that reports memory routes.
publishMemoryVersion(1);

const sampleAvatar = (initials: string, color: string) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="24" fill="${color}"/><text x="48" y="60" text-anchor="middle" font-family="system-ui" font-size="32" fill="#fff">${initials}</text></svg>`);

const memoryClient = createPreviewMemoryClient();
if (empty) memoryClient.listLessons = async () => [];

const conversation: Conversation = {
  id: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID,
  canonicalSessionId: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID,
  name: 'Launch copy with Priya',
  type: 'person',
  subtitle: '',
  unread: 0,
  collaborationSources: ['Cloud'],
  trust: 'Cloud',
  directness: 'Direct chat',
  participants: ['Me', 'Priya Nair'],
  messages: [],
  canonicalParticipants: [
    { id: 'acct_taylor', name: 'Me', publicName: 'Taylor Reed', kind: 'human', role: 'owner', profileImageUrl: sampleAvatar('TR', '#53776b') },
    { id: 'acct_priya', name: 'Priya Nair', kind: 'human', role: 'member', profileImageUrl: sampleAvatar('PN', '#98705b') },
  ],
} as Conversation;

const artifacts: SessionArtifact[] = empty ? [] : [
  { id: 'launch-brief', path: 'notes/launch-brief.md', name: 'launch-brief.md', kind: 'document', category: 'artifact', summary: 'Created', timeLabel: '10:24', createdByAccountId: 'acct_priya' },
  { id: 'pricing-page', path: 'site/pricing.html', name: 'pricing.html', kind: 'document', category: 'artifact', summary: 'Created', timeLabel: '09:58' },
  { id: 'headline-test', path: 'src/headlines.ts', name: 'headlines.ts', kind: 'code', category: 'related', summary: 'Modified', timeLabel: '09:41' },
];

// A chat that can take an attachment, so the Artifacts tab offers New document and Add file.
const readerHost: DocumentReaderHost = {
  viewer: null,
  sessionId: conversation.id,
  agentName: null,
  people: [],
  addDocument: () => undefined,
  opensDocumentsInCompanion: true,
};

function Preview() {
  const [tab, setTab] = useState<'info' | 'artifacts' | 'tasks' | 'memory'>(params.get('tab') === 'memory' ? 'memory' : 'artifacts');
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  return (
    <div
      className={`kordi-app theme-${theme}`}
      style={{ height: '100vh', background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}
    >
      <div className="app-chat-main-workspace flex h-full min-h-0 min-w-0 overflow-hidden">
        <section className="app-chat-pane-layout min-h-0 min-w-0 flex-1 overflow-hidden" data-has-header="true">
          <div className="app-page-header app-chat-pane-header relative flex shrink-0 flex-col items-start gap-2" style={{ padding: '14px 20px 0' }}>
            <div className="text-[17px] font-semibold">{conversation.name}</div>
            <div style={{ position: 'relative', height: 34 }}>
              <SessionDestinationTabs
                scope="main"
                activeDestination={tab}
                onSelect={(destination) => setTab(destination === 'messages' ? 'artifacts' : destination)}
              />
            </div>
          </div>
          {/* The split workspace class supplies the page padding the app gives detail tabs. */}
          <div className="app-chat-split-workspace min-h-0 min-w-0 flex-1 overflow-hidden">
            <RightDetailRail
              variant="page"
              detailTabs={CHAT_DETAIL_TABS}
              activeDetailTab={tab}
              onSelectDetailTab={(next) => setTab(next === 'context' ? 'info' : next)}
              activeSourcePreview={null}
              onCloseSourcePreview={() => undefined}
            >
              {tab === 'memory' ? <ChatMemoryTab conversation={conversation} client={memoryClient} /> : null}
              {tab === 'artifacts' ? (
                <DocumentReaderHostContext.Provider value={readerHost}>
                  <ChatDetailPanel
                    isNativeShell={false}
                    activeDetailTab="artifacts"
                    activeConv={conversation}
                    activeConvHasSubtitle={false}
                    activeConversationUsesCollaboration
                    activeCollaborationAwaitingReply={false}
                    isCollaborationSyncing={false}
                    artifacts={artifacts}
                    activeArtifactId={activeArtifactId}
                    onSelectArtifact={setActiveArtifactId}
                  />
                </DocumentReaderHostContext.Provider>
              ) : null}
            </RightDetailRail>
          </div>
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);

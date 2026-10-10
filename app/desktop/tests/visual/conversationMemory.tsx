// Login-free synthetic preview of a conversation's Memory tab: the real
// destination tabs, detail page, and memory list with the preview memory
// client. `?chat=group` opens the group chat whose id matches the sample group
// memory. It makes no network calls and needs no session.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { publishMemoryVersion } from '../../src/features/memory/memoryAvailability';
import {
  PREVIEW_CONVERSATION_MEMORY_SCOPE_ID,
  PREVIEW_GROUP_MEMORY_SCOPE_ID,
  createPreviewMemoryClient,
} from '../../src/features/memory/memoryClient';
import { ChatMemoryTab } from '../../src/pages/ChatMemoryTab';
import { RightDetailRail } from '../../src/pages/RightDetailRail';
import { SessionDestinationTabs } from '../../src/pages/chatsPage.destinations';
import { CHAT_DETAIL_TABS } from '../../src/pages/chatsPage.destinationModel';

const params = new URLSearchParams(window.location.search);
const requestedTheme = params.get('theme');
const isGroup = params.get('chat') === 'group';
const prefersLight = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
const theme: 'light' | 'dark' = requestedTheme === 'light' || requestedTheme === 'dark'
  ? requestedTheme
  : prefersLight ? 'light' : 'dark';

document.body.classList.toggle('theme-light', theme === 'light');
document.body.classList.toggle('theme-dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

// The preview stands in for a server that reports memory routes.
publishMemoryVersion(1);

const groupSessionId = `session:group:${PREVIEW_GROUP_MEMORY_SCOPE_ID}`;
const conversation = isGroup
  ? { id: groupSessionId, canonicalSessionId: groupSessionId, participantSpaceId: `group:${groupSessionId}` }
  : { id: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID, canonicalSessionId: PREVIEW_CONVERSATION_MEMORY_SCOPE_ID };
const memoryClient = createPreviewMemoryClient();

function Preview() {
  const [tab, setTab] = useState<'info' | 'artifacts' | 'tasks' | 'memory'>('memory');
  return (
    <div
      className={`kordi-app theme-${theme}`}
      style={{ height: '100vh', background: 'var(--utility-background)', color: 'var(--utility-foreground)' }}
    >
      <div className="app-chat-main-workspace flex h-full min-h-0 min-w-0 overflow-hidden">
        <section className="app-chat-pane-layout min-h-0 min-w-0 flex-1 overflow-hidden" data-has-header="true">
          <div className="app-page-header app-chat-pane-header relative flex shrink-0 flex-col items-start gap-2" style={{ padding: '14px 20px 0' }}>
            <div className="text-[17px] font-semibold">{isGroup ? 'Design review' : 'Launch copy with Priya'}</div>
            <div style={{ position: 'relative', height: 34 }}>
              <SessionDestinationTabs
                scope="main"
                activeDestination={tab}
                onSelect={(destination) => setTab(destination === 'messages' ? 'memory' : destination)}
              />
            </div>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <RightDetailRail
              variant="page"
              detailTabs={CHAT_DETAIL_TABS}
              activeDetailTab={tab}
              onSelectDetailTab={(next) => setTab(next === 'context' ? 'info' : next)}
              activeSourcePreview={null}
              onCloseSourcePreview={() => undefined}
            >
              {tab === 'memory' ? <ChatMemoryTab conversation={conversation} client={memoryClient} /> : null}
            </RightDetailRail>
          </div>
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);

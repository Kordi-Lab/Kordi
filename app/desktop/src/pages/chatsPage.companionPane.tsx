import type { ComponentProps, ReactNode } from 'react';

import type { Conversation } from '@/kordi-app/types';
import type { ChatDestination } from '@/pages/chatsPage.destinationModel';
import type { CompanionSide } from '@/pages/chatsPage.model';
import {
  ChatComposerShell,
  ChatSessionPane,
} from '@/pages/chatsPage.sessionPane';

type SessionPaneProps = ComponentProps<typeof ChatSessionPane>;

type CompanionPaneProps = {
  conversation: Conversation;
  side: CompanionSide;
  destination: ChatDestination;
  header: ReactNode;
  detailPage: ReactNode;
  sessionPane: Omit<SessionPaneProps, 'viewport'> & {
    viewport: Omit<SessionPaneProps['viewport'], 'composer'>;
  };
  composerShell: Omit<ComponentProps<typeof ChatComposerShell>, 'children'>;
  composer: ReactNode;
};

export function CompanionPane({
  conversation,
  side,
  destination,
  header,
  detailPage,
  sessionPane,
  composerShell,
  composer,
}: CompanionPaneProps) {
  return (
    <aside
      className="app-chat-companion-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white/[0.025]"
      data-side={side}
      data-chat-side-agent-panel="true"
      data-companion-session-id={conversation.id}
    >
      {header}
      {destination === 'messages' ? (
        <div
          id="chat-companion-messages-panel"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          role="tabpanel"
          aria-labelledby="chat-companion-messages-tab"
          data-chat-destination-page="messages"
          data-chat-destination-scope="companion"
        >
          <ChatSessionPane
            presentation={sessionPane.presentation}
            actions={sessionPane.actions}
            selection={sessionPane.selection}
            viewport={{
              ...sessionPane.viewport,
              composer: (
                <ChatComposerShell {...composerShell}>
                  {composer}
                </ChatComposerShell>
              ),
            }}
          />
        </div>
      ) : detailPage}
    </aside>
  );
}

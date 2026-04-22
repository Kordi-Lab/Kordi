import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import type { DetailTab, SessionArtifact } from '@/kordi-app/types';
import { TypeBadge } from '@/kordi-app/components';
import { ArtifactInspector } from '@/pages/ArtifactInspector';

type ActiveConversation = {
  name: string;
  subtitle: string;
  type: 'person' | 'owned-agent' | 'external-agent';
  bridges: string[];
  trust: string;
  directness: string;
  participants: string[];
};

type ProjectSource = {
  label: string;
  path?: string | null;
  detail?: string | null;
};

type SessionProjectInfo = {
  name: string;
  root: string;
  sharedContext?: string | null;
  backgroundSystem?: string | null;
  sharedSources: ProjectSource[];
};

type BridgeConversation = {
  peerNodeId: string;
  peerRuntime: string;
  projectName?: string | null;
  projectId?: string | null;
};

type ChatDetailPanelProps = {
  isNativeShell: boolean;
  activeDetailTab: DetailTab;
  activeConv: ActiveConversation;
  activeConvHasSubtitle: boolean;
  activeLastMessage?: { time?: string; text?: string };
  activeConversationIsBridge: boolean;
  activeBridgeConversationHostNodeId?: string | null;
  activeBridgeConversationHostUrl?: string | null;
  activeBridgeConversation?: BridgeConversation | null;
  activeBridgeAwaitingReply: boolean;
  isBridgePolling: boolean;
  lastBridgePollAtLabel?: string | null;
  activeSessionProject?: SessionProjectInfo | null;
  artifacts: SessionArtifact[];
  activeArtifactId: string | null;
  onSelectArtifact: (artifactId: string | null) => void;
};

type MetaRowProps = {
  label: string;
  value?: ReactNode;
  valueClassName?: string;
};

function MetaRow({ label, value, valueClassName }: MetaRowProps) {
  return (
    <div className="app-inspector-meta-row">
      <span className="app-inspector-meta-label">{label}</span>
      <span className={['app-inspector-meta-value', valueClassName].filter(Boolean).join(' ')}>{value ?? '—'}</span>
    </div>
  );
}

function EmphasisBlock({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={['app-inspector-emphasis', className].filter(Boolean).join(' ')}>
      {title ? <div className="mb-1.5 app-inspector-heading">{title}</div> : null}
      <div className="app-inspector-text-block">{children}</div>
    </div>
  );
}

export function ChatDetailPanel({
  isNativeShell,
  activeDetailTab,
  activeConv,
  activeConvHasSubtitle,
  activeLastMessage,
  activeConversationIsBridge,
  activeBridgeConversationHostNodeId,
  activeBridgeConversationHostUrl,
  activeBridgeConversation,
  activeBridgeAwaitingReply,
  isBridgePolling,
  lastBridgePollAtLabel,
  activeSessionProject,
  artifacts,
  activeArtifactId,
  onSelectArtifact,
}: ChatDetailPanelProps) {
  if (activeDetailTab === 'info') {
    return (
      <div className="app-detail-sheet">
        <section className="app-detail-section">
          <div className="app-detail-kicker">Session info</div>
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="app-inspector-heading">{activeConv.name}</div>
                {activeConvHasSubtitle ? <div className="mt-1 app-inspector-subtext">{activeConv.subtitle}</div> : null}
              </div>
              <TypeBadge type={activeConv.type} compact />
            </div>
            <div className="app-inspector-meta-list">
              <MetaRow label="Last active" value={activeLastMessage?.time} />
              <MetaRow label="Trust" value={activeConv.trust} />
              <MetaRow label="Mode" value={activeConv.directness} />
            </div>
          </div>
        </section>

        <section className="app-detail-section">
          <div className="app-detail-kicker">Participants</div>
          <div className="app-inspector-list">
            {activeConv.participants.map((participant) => (
              <div key={participant} className="app-inspector-list-row">
                <span className="truncate text-[13px] text-[color:var(--utility-foreground)]">{participant}</span>
                <Badge variant="secondary" className="app-badge-neutral rounded-full px-2.5 py-1">
                  Active
                </Badge>
              </div>
            ))}
          </div>
        </section>

        {activeConversationIsBridge && activeBridgeConversation ? (
          <section className="app-detail-section">
            <div className="app-detail-kicker">Bridge delivery</div>
            <div className="app-inspector-meta-list">
              <MetaRow label="Host" value={activeBridgeConversationHostUrl || 'Unknown'} valueClassName="max-w-[11rem] truncate" />
              <MetaRow label="Peer node" value={activeBridgeConversation.peerNodeId} valueClassName="max-w-[11rem] truncate" />
              <MetaRow label="Runtime" value={activeBridgeConversation.peerRuntime} />
              <MetaRow
                label="Project"
                value={activeBridgeConversation.projectName || activeBridgeConversation.projectId || 'Direct bridge chat'}
                valueClassName="max-w-[11rem] truncate"
              />
              <MetaRow label="Delivery state" value={activeBridgeAwaitingReply ? 'Awaiting reply' : 'Idle / replied'} />
              <MetaRow label="Mailbox polling" value={isBridgePolling ? 'Polling now' : (lastBridgePollAtLabel || 'Not polled yet')} />
            </div>
          </section>
        ) : null}

        {!activeConversationIsBridge && activeSessionProject ? (
          <>
            <section className="app-detail-section">
              <div className="app-detail-kicker">Related project</div>
              <div className="space-y-3">
                <EmphasisBlock>
                  <div className="app-inspector-heading">{activeSessionProject.name}</div>
                  <div className="mt-1 break-all app-inspector-subtext">{activeSessionProject.root}</div>
                </EmphasisBlock>
                {activeSessionProject.sharedContext ? <EmphasisBlock title="Shared context">{activeSessionProject.sharedContext}</EmphasisBlock> : null}
                {activeSessionProject.backgroundSystem ? <EmphasisBlock title="Background system">{activeSessionProject.backgroundSystem}</EmphasisBlock> : null}
              </div>
            </section>

            <section className="app-detail-section">
              <div className="app-detail-kicker">Shared information sources</div>
              {activeSessionProject.sharedSources.length > 0 ? (
                <div className="app-inspector-list">
                  {activeSessionProject.sharedSources.map((source, index) => (
                    <div key={`${source.label}-${source.path ?? index}`} className="app-inspector-source-row">
                      <div className="app-inspector-heading">{source.label}</div>
                      {source.path ? <div className="mt-1 break-all app-inspector-subtext">{source.path}</div> : null}
                      {source.detail ? <div className="mt-1 app-inspector-text-block">{source.detail}</div> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="app-inspector-empty">No shared project sources configured yet.</div>
              )}
            </section>
          </>
        ) : null}
      </div>
    );
  }

  if (activeDetailTab === 'context') {
    return (
      <div className="app-detail-sheet">
        <section className="app-detail-section">
          <div className="app-detail-kicker">Session context</div>
          <div className="space-y-3">
            {activeConvHasSubtitle ? <EmphasisBlock title="Current focus">{activeConv.subtitle}</EmphasisBlock> : null}
            <EmphasisBlock title="Latest update">{activeLastMessage?.text ?? 'No recent update yet.'}</EmphasisBlock>
          </div>
        </section>

        <section className="app-detail-section">
          <div className="app-detail-kicker">Delivery context</div>
          <div className="app-inspector-meta-list">
            <MetaRow label="Bridges" value={activeConv.bridges.join(' • ')} />
            <MetaRow label="Source" value={activeConversationIsBridge ? (activeBridgeConversationHostNodeId || 'desktop node') : 'cc_node_01'} />
            <MetaRow label="Transport" value={activeConversationIsBridge ? 'Mailbox relay' : 'Encrypted'} />
            {activeConversationIsBridge ? (
              <MetaRow label="Live status" value={isBridgePolling ? 'Polling…' : (activeBridgeAwaitingReply ? 'Waiting for reply' : 'Up to date')} />
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  if (activeDetailTab === 'artifacts') {
    return (
      <div className="app-detail-sheet">
        <ArtifactInspector
          isNativeShell={isNativeShell}
          artifacts={artifacts}
          activeArtifactId={activeArtifactId}
          onSelectArtifact={onSelectArtifact}
          emptyMessage={activeConversationIsBridge ? 'Bridge conversations do not have local generated artifacts yet.' : 'No generated code or docs in this session yet.'}
        />
      </div>
    );
  }

  return (
    <div className="app-detail-sheet">
      <section className="app-detail-section">
        <div className="app-detail-kicker">Tasks</div>
        <div className="space-y-3">
          <EmphasisBlock title="Research Agent relay">
            <div className="mb-2">
              <Badge className="app-badge-neutral px-2.5 py-1">Running</Badge>
            </div>
            Waiting for external follow-up notes.
          </EmphasisBlock>
          <EmphasisBlock title="Code Agent outbound share">
            <div className="mb-2">
              <Badge variant="secondary" className="app-badge-attention px-2.5 py-1">
                Needs approval
              </Badge>
            </div>
            Agent wants to send a patch summary to Bob.
          </EmphasisBlock>
        </div>
      </section>
    </div>
  );
}

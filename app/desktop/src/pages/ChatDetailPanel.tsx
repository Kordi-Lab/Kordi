import type { ReactNode } from 'react';

import { MessageSquareMore } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getLocalProfileAvatarSeed, IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { DesktopBridgeIdentitySnapshot, DesktopBridgeOutreachMetadata, DetailTab, OutreachThreadSummary, SessionArtifact } from '@/kordi-app/types';
import { TypeBadge } from '@/kordi-app/components';
import { ArtifactInspector } from '@/pages/ArtifactInspector';

type ActiveConversation = {
  id: string;
  name: string;
  canonicalSessionId?: string;
  canonicalStoragePath?: string;
  canonicalParticipantCount?: number;
  canonicalMessageCount?: number;
  canonicalDelegatedExchangeCount?: number;
  canonicalContextSnapshotCount?: number;
  canonicalPresenceSummary?: string;
  canonicalParticipants?: Array<{
    id: string;
    name: string;
    kind: 'human' | 'agent' | string;
    role: string;
    avatarKey?: string | null;
    profileImageUrl?: string | null;
    presenceStatus?: string | null;
    presenceDetail?: string | null;
  }>;
  subtitle: string;
  type: 'person' | 'owned-agent' | 'external-agent';
  bridges: string[];
  trust: string;
  directness: string;
  participants: string[];
  outreach?: DesktopBridgeOutreachMetadata | null;
  identity?: DesktopBridgeIdentitySnapshot | null;
  outreachThreads?: OutreachThreadSummary[];
  participantAvatarSeeds?: Record<string, string>;
};

function participantAvatarSeed(activeConv: ActiveConversation, participant: string, isAgent: boolean) {
  const normalizedParticipant = participant.trim();
  const explicitSeed = activeConv.participantAvatarSeeds?.[participant] ?? activeConv.participantAvatarSeeds?.[normalizedParticipant];
  if (explicitSeed?.trim()) return explicitSeed;

  const identity = activeConv.identity;

  if (/^(you|me)$/i.test(normalizedParticipant)) {
    return getLocalProfileAvatarSeed();
  }
  if (isAgent) {
    if (identity?.localAgentName && normalizedParticipant === identity.localAgentName) {
      return identity.localAgentId || identity.localAgentNodeId || identity.localAgentName;
    }
    if (identity?.remoteAgentName && normalizedParticipant === identity.remoteAgentName) {
      return identity.remoteAgentId || identity.remoteAgentNodeId || identity.remoteAgentName;
    }
    return normalizedParticipant;
  }
  if (identity?.localHumanName && normalizedParticipant === identity.localHumanName) {
    return identity.localHumanId || identity.localHumanName;
  }
  if (identity?.remoteHumanName && normalizedParticipant === identity.remoteHumanName) {
    return identity.remoteHumanId || identity.remoteHumanNodeId || identity.remoteHumanName;
  }
  return normalizedParticipant;
}

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
  title?: string;
  peerTyping?: boolean;
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
  onOpenOutreachThread?: (conversationId: string) => void;
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
  onOpenOutreachThread,
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
              <MetaRow label="Session ID" value={activeConv.canonicalSessionId ?? activeConv.id} valueClassName="max-w-[11rem] truncate" />
              {activeConv.canonicalStoragePath ? <MetaRow label="Local DB" value={activeConv.canonicalStoragePath} valueClassName="max-w-[11rem] truncate" /> : null}
              {activeConv.canonicalParticipantCount !== undefined ? <MetaRow label="Canonical graph" value={`${activeConv.canonicalParticipantCount} participant${activeConv.canonicalParticipantCount === 1 ? '' : 's'} • ${activeConv.canonicalMessageCount ?? 0} message${activeConv.canonicalMessageCount === 1 ? '' : 's'} • ${activeConv.canonicalDelegatedExchangeCount ?? 0} delegation${activeConv.canonicalDelegatedExchangeCount === 1 ? '' : 's'}`} /> : null}
              {activeConv.canonicalContextSnapshotCount !== undefined ? <MetaRow label="Context cache" value={`${activeConv.canonicalContextSnapshotCount} snapshot${activeConv.canonicalContextSnapshotCount === 1 ? '' : 's'}`} /> : null}
              {activeConv.canonicalPresenceSummary ? <MetaRow label="Presence" value={activeConv.canonicalPresenceSummary} /> : null}
              <MetaRow label="Last active" value={activeLastMessage?.time} />
              <MetaRow label="Trust" value={activeConv.trust} />
              <MetaRow label="Mode" value={activeConv.directness} />
              {activeConv.outreach ? <MetaRow label="Outreach status" value={activeConv.outreach.status} /> : null}
            </div>
          </div>
        </section>

        <section className="app-detail-section">
          <div className="app-detail-kicker">Participants</div>
          <div className="app-inspector-list">
            {activeConv.canonicalParticipants?.length ? activeConv.canonicalParticipants.map((participant) => {
              const isAgent = participant.kind === 'agent';
              const status = participant.presenceStatus && participant.presenceStatus !== 'offline'
                ? participant.presenceStatus
                : participant.role;

              return (
                <div key={participant.id} className="app-inspector-list-row">
                  <span className="flex min-w-0 items-center gap-2">
                    <IdentityAvatar
                      kind={isAgent ? 'agent' : 'human'}
                      seed={participant.avatarKey ?? participant.name}
                      imageUrl={participant.profileImageUrl}
                      name={participant.name}
                      className="h-7 w-7 border border-white/10"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-[color:var(--utility-foreground)]">{participant.name}</span>
                      {participant.presenceDetail ? <span className="block truncate text-[11px] text-slate-500">{participant.presenceDetail}</span> : null}
                    </span>
                  </span>
                  <Badge variant="secondary" className="app-badge-neutral rounded-full px-2.5 py-1">
                    {status}
                  </Badge>
                </div>
              );
            }) : activeConv.participants.map((participant) => {
              const isAgent = activeConv.type !== 'person' && /agent|bot|assistant/i.test(participant);

              return (
                <div key={participant} className="app-inspector-list-row">
                  <span className="flex min-w-0 items-center gap-2">
                    <IdentityAvatar
                      kind={isAgent ? 'agent' : 'human'}
                      seed={participantAvatarSeed(activeConv, participant, isAgent)}
                      name={participant}
                      className="h-7 w-7 border border-white/10"
                    />
                    <span className="truncate text-[13px] text-[color:var(--utility-foreground)]">{participant}</span>
                  </span>
                  <Badge variant="secondary" className="app-badge-neutral rounded-full px-2.5 py-1">
                    Active
                  </Badge>
                </div>
              );
            })}
          </div>
        </section>

        {activeConv.outreachThreads && activeConv.outreachThreads.length > 0 ? (
          <section className="app-detail-section">
            <div className="app-detail-kicker">Outreach threads</div>
            <div className="space-y-2">
              {activeConv.outreachThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => onOpenOutreachThread?.(thread.id)}
                  className="group w-full rounded-[18px] border border-[color:var(--app-divider)] bg-white/[0.025] px-3 py-2.5 text-left transition hover:border-white/15 hover:bg-white/[0.045]"
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.05] text-slate-300 ring-1 ring-white/10">
                      <MessageSquareMore className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="truncate text-[13px] font-medium text-[color:var(--utility-foreground)]">{thread.targetDisplayName || thread.title}</div>
                        <Badge variant="outline" className="shrink-0 rounded-full border-white/10 px-1.5 py-0 text-[10px] text-slate-400">
                          {thread.targetKind === 'bridge-person' ? 'person' : 'agent'}
                        </Badge>
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">{thread.subtitle}</div>
                      <div className="mt-1 text-[11px] text-slate-500">{thread.status}{thread.updatedAtLabel ? ` • ${thread.updatedAtLabel}` : ''}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {activeConv.outreach ? (
          <section className="app-detail-section">
            <div className="app-detail-kicker">Outreach</div>
            <div className="space-y-3">
              <EmphasisBlock title={activeConv.outreach.targetKind === 'bridge-person' ? 'Person outreach' : 'Agent outreach'}>
                <div>{activeConv.outreach.requestText}</div>
                {activeConv.outreach.contextText ? <div className="mt-2 app-inspector-subtext">Context included by default</div> : null}
              </EmphasisBlock>
              <div className="app-inspector-meta-list">
                <MetaRow label="Target" value={activeConv.outreach.targetDisplayName} />
                <MetaRow label="Owner" value={activeConv.outreach.targetOwnerName} />
                <MetaRow label="Parent session" value={activeConv.outreach.parentSessionId} valueClassName="max-w-[11rem] truncate" />
                <MetaRow label="Local human" value={activeConv.identity?.localHumanName} />
                <MetaRow label="Local agent" value={activeConv.identity?.localAgentName} />
                <MetaRow label="Remote human" value={activeConv.identity?.remoteHumanName} />
                <MetaRow label="Remote agent" value={activeConv.identity?.remoteAgentName} />
              </div>
            </div>
          </section>
        ) : null}

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
              {activeBridgeConversation.peerTyping ? <MetaRow label="Typing" value={`${activeBridgeConversation.title} is typing…`} /> : null}
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
            <MetaRow label="Transport" value={activeConversationIsBridge ? (activeBridgeConversation?.peerRuntime === 'person' ? 'Direct realtime' : 'Bridge relay') : 'Encrypted'} />
            {activeConversationIsBridge && activeBridgeConversation?.peerTyping ? (
              <MetaRow label="Typing" value={`${activeBridgeConversation.title} is typing…`} />
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

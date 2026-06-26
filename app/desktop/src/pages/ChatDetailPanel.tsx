import { memo, useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { formatSessionIdSubtitle } from '@/app/viewModels/helpers';
import { getLocalProfileAvatarSeed, IdentityAvatar, useLocalAgentAvatarSeed, useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { DesktopBridgeIdentitySnapshot, DesktopBridgeOutreachMetadata, DesktopChatTurnSnapshot, DetailTab, Message, OutreachThreadSummary, SessionArtifact, SessionTaskActivity } from '@/kordi-app/types';
import { ArtifactInspector } from '@/pages/ArtifactInspector';
import { TaskActivityDashboardPanel } from '@/pages/TaskActivityDashboardPanel';
import { useScheduledTasks } from '@/features/cloud/useScheduledTasks';
import { firstPersonPossessiveLabel, isSelfReferenceName, selfDisplayName, selfObjectLabel } from '@/lib/identityLabels';

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
  localSessionCwd?: string | null;
  canonicalParticipants?: Array<{
    id: string;
    name: string;
    kind: 'human' | 'agent' | string;
    role: string;
    ownerIdentityId?: string | null;
    ownerName?: string | null;
    avatarKey?: string | null;
    profileImageUrl?: string | null;
    presenceStatus?: string | null;
    presenceDetail?: string | null;
    source?: string | null;
    bridgeHostId?: string | null;
    bridgeNodeId?: string | null;
    humanId?: string | null;
    agentId?: string | null;
  }>;
  subtitle: string;
  type: 'person' | 'owned-agent' | 'external-agent';
  bridges: string[];
  trust: string;
  directness: string;
  participants: string[];
  messages: Message[];
  outreach?: DesktopBridgeOutreachMetadata | null;
  identity?: DesktopBridgeIdentitySnapshot | null;
  outreachThreads?: OutreachThreadSummary[];
  taskActivities?: SessionTaskActivity[];
  participantAvatarSeeds?: Record<string, string>;
  participantProfileImageUrls?: Record<string, string | null>;
};

function participantProfileImageUrl(activeConv: ActiveConversation, participant: string) {
  const normalizedParticipant = participant.trim();
  return activeConv.participantProfileImageUrls?.[participant]
    ?? activeConv.participantProfileImageUrls?.[normalizedParticipant]
    ?? null;
}

function participantAvatarSeed(activeConv: ActiveConversation, participant: string, isAgent: boolean, localProfileSeed?: string, localAgentSeed?: string) {
  const normalizedParticipant = participant.trim();
  const explicitSeed = activeConv.participantAvatarSeeds?.[participant] ?? activeConv.participantAvatarSeeds?.[normalizedParticipant];
  if (explicitSeed?.trim()) return explicitSeed;

  const identity = activeConv.identity;

  if (/^(you|me)$/i.test(normalizedParticipant)) {
    return localProfileSeed || getLocalProfileAvatarSeed();
  }
  if (isAgent) {
    if (/^(kordi|agent|assistant|my\s+.+)$/i.test(normalizedParticipant)) {
      return localAgentSeed || normalizedParticipant;
    }
    if (identity?.localAgentName && normalizedParticipant === identity.localAgentName) {
      return identity.localAgentId || identity.localAgentNodeId || localAgentSeed || identity.localAgentName;
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

function canonicalParticipantOwnerIsSelf(activeConv: ActiveConversation, participant: NonNullable<ActiveConversation['canonicalParticipants']>[number]) {
  if (isSelfReferenceName(participant.ownerName)) return true;
  const ownerIdentityId = participant.ownerIdentityId?.trim();
  if (!ownerIdentityId) return false;
  return activeConv.canonicalParticipants?.some((candidate) => (
    candidate.id === ownerIdentityId
    && (candidate.role === 'self' || isSelfReferenceName(candidate.name))
  )) ?? false;
}

function canonicalParticipantDisplayName(activeConv: ActiveConversation, participant: NonNullable<ActiveConversation['canonicalParticipants']>[number]) {
  const isSelfHuman = participant.kind !== 'agent' && (participant.role === 'self' || isSelfReferenceName(participant.name));
  if (isSelfHuman) return selfDisplayName(participant.name, true);
  if (participant.kind === 'agent' && canonicalParticipantOwnerIsSelf(activeConv, participant)) {
    return firstPersonPossessiveLabel(participant.name, participant.ownerName);
  }
  return selfDisplayName(participant.name);
}

function canonicalParticipantOwnerLabel(activeConv: ActiveConversation, participant: NonNullable<ActiveConversation['canonicalParticipants']>[number]) {
  if (!participant.ownerName) return null;
  return selfObjectLabel(participant.ownerName, canonicalParticipantOwnerIsSelf(activeConv, participant));
}

function canonicalParticipantAvatarSeed(
  activeConv: ActiveConversation,
  participant: NonNullable<ActiveConversation['canonicalParticipants']>[number],
  localProfileSeed?: string,
  localAgentSeed?: string,
) {
  const fallbackSeed = participant.avatarKey?.trim() || participant.name;
  const isSelfHuman = participant.kind !== 'agent' && (participant.role === 'self' || isSelfReferenceName(participant.name));
  if (isSelfHuman) return localProfileSeed || fallbackSeed;

  const isLocalOwnedAgent = participant.kind === 'agent'
    && (participant.source === 'local' || canonicalParticipantOwnerIsSelf(activeConv, participant));
  if (isLocalOwnedAgent) return localAgentSeed || fallbackSeed;

  return fallbackSeed;
}

function identityAvatarPresenceStatus(status?: string | null) {
  return status?.trim().toLowerCase() === 'online' ? 'online' : 'offline';
}

function identityAvatarPresenceLabel(status?: string | null) {
  return `Status: ${identityAvatarPresenceStatus(status)}`;
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

export function chatArtifactPreviewBaseRoot({
  activeConversationIsBridge,
  activeSessionProjectRoot,
  activeSessionWorkspaceRoot,
}: {
  activeConversationIsBridge: boolean;
  activeSessionProjectRoot?: string | null;
  activeSessionWorkspaceRoot?: string | null;
}) {
  if (activeConversationIsBridge) return null;
  const projectRoot = activeSessionProjectRoot?.trim();
  if (projectRoot) return projectRoot;
  const sessionRoot = activeSessionWorkspaceRoot?.trim();
  return sessionRoot || null;
}

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
  activeLiveTurn?: DesktopChatTurnSnapshot | null;
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
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
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

function ChatDetailPanelView({
  isNativeShell,
  activeDetailTab,
  activeConv,
  activeConvHasSubtitle,
  activeLastMessage,
  activeLiveTurn,
  activeConversationIsBridge,
  activeSessionProject,
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  onOpenArtifact,
  onNavigateToResponse,
}: ChatDetailPanelProps) {
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const currentLocalAgentAvatarSeed = useLocalAgentAvatarSeed(activeConv.name);
  const activeSessionSubtitle = formatSessionIdSubtitle(activeConv.subtitle);
  const activeSessionId = activeConv.canonicalSessionId ?? activeConv.id;
  const artifactPreviewBaseRoot = chatArtifactPreviewBaseRoot({
    activeConversationIsBridge,
    activeSessionProjectRoot: activeSessionProject?.root,
    activeSessionWorkspaceRoot: activeConv.localSessionCwd,
  });
  const scheduledTasks = useScheduledTasks({ enabled: true });

  useEffect(() => {
    if (activeLiveTurn?.completed) void scheduledTasks.refresh();
  }, [activeLiveTurn?.completed, scheduledTasks.refresh]);

  if (activeDetailTab === 'info') {
    return (
      <div className="app-detail-sheet">
        <section className="app-detail-section">
          <div className="app-detail-kicker">Overview</div>
          <div className="space-y-3">
            <div className="min-w-0">
              <div className="app-inspector-heading">{activeConv.name}</div>
            </div>
            <div className="app-inspector-meta-list">
              {activeConv.canonicalParticipantCount !== undefined ? <MetaRow label="Canonical graph" value={`${activeConv.canonicalParticipantCount} participant${activeConv.canonicalParticipantCount === 1 ? '' : 's'} • ${activeConv.canonicalMessageCount ?? 0} message${activeConv.canonicalMessageCount === 1 ? '' : 's'} • ${activeConv.canonicalDelegatedExchangeCount ?? 0} delegation${activeConv.canonicalDelegatedExchangeCount === 1 ? '' : 's'}`} /> : null}
              {activeConv.canonicalContextSnapshotCount !== undefined ? <MetaRow label="Context cache" value={`${activeConv.canonicalContextSnapshotCount} snapshot${activeConv.canonicalContextSnapshotCount === 1 ? '' : 's'}`} /> : null}
              {activeConv.canonicalPresenceSummary ? <MetaRow label="Presence" value={activeConv.canonicalPresenceSummary} /> : null}
              <MetaRow label="Last active" value={activeLastMessage?.time} />
            </div>
          </div>
        </section>

        <section className="app-detail-section">
          <div className="app-detail-kicker">Participants</div>
          <div className="app-inspector-list">
            {activeConv.canonicalParticipants?.length ? activeConv.canonicalParticipants.map((participant) => {
              const isAgent = participant.kind === 'agent';
              const displayName = canonicalParticipantDisplayName(activeConv, participant);
              const ownerLabel = canonicalParticipantOwnerLabel(activeConv, participant);

              return (
                <div key={participant.id} className="app-inspector-list-row">
                  <span className="flex min-w-0 items-center gap-2">
                    <IdentityAvatar
                      kind={isAgent ? 'agent' : 'human'}
                      seed={canonicalParticipantAvatarSeed(activeConv, participant, currentLocalProfileAvatarSeed, currentLocalAgentAvatarSeed)}
                      imageUrl={participant.profileImageUrl}
                      name={displayName}
                      className="h-7 w-7 border border-white/10"
                      presenceStatus={identityAvatarPresenceStatus(participant.presenceStatus)}
                      presenceLabel={identityAvatarPresenceLabel(participant.presenceStatus)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-[color:var(--utility-foreground)]">{displayName}</span>
                      {ownerLabel ? <span className="block truncate text-[11px] text-slate-500">Owner: {ownerLabel}</span> : participant.presenceDetail ? <span className="block truncate text-[11px] text-slate-500">{participant.presenceDetail}</span> : null}
                    </span>
                  </span>
                </div>
              );
            }) : activeConv.participants.map((participant) => {
              const displayName = selfDisplayName(participant);
              const isAgent = activeConv.type !== 'person' && /agent|bot|assistant|kordi/i.test(participant);

              return (
                <div key={participant} className="app-inspector-list-row">
                  <span className="flex min-w-0 items-center gap-2">
                    <IdentityAvatar
                      kind={isAgent ? 'agent' : 'human'}
                      seed={participantAvatarSeed(activeConv, participant, isAgent, currentLocalProfileAvatarSeed, currentLocalAgentAvatarSeed)}
                      imageUrl={participantProfileImageUrl(activeConv, participant)}
                      name={displayName}
                      className="h-7 w-7 border border-white/10"
                      presenceStatus="online"
                      presenceLabel="Status: online"
                    />
                    <span className="truncate text-[13px] text-[color:var(--utility-foreground)]">{displayName}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </section>

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
            {activeConvHasSubtitle ? <EmphasisBlock title="Current focus">{activeSessionSubtitle}</EmphasisBlock> : null}
            <EmphasisBlock title="Latest update">{activeLastMessage?.text ?? 'No recent update yet.'}</EmphasisBlock>
          </div>
        </section>
      </div>
    );
  }

  if (activeDetailTab === 'artifacts') {
    return (
      <div className="app-detail-sheet flex h-full min-h-0 flex-col overflow-hidden">
        <ArtifactInspector
          isNativeShell={isNativeShell}
          artifacts={artifacts}
          activeArtifactId={activeArtifactId}
          onSelectArtifact={onSelectArtifact}
          previewBaseRoot={artifactPreviewBaseRoot}
          emptyMessage={activeConversationIsBridge ? 'No generated code or docs in this chat yet.' : 'No generated code or docs in this session yet.'}
        />
      </div>
    );
  }

  return (
    <div className="app-detail-sheet">
      <TaskActivityDashboardPanel
        messages={activeConv.messages}
        liveTurn={activeLiveTurn?.sessionId === activeSessionId ? activeLiveTurn : null}
        taskActivities={activeConv.taskActivities ?? []}
        scheduledTasks={scheduledTasks.tasks}
        scheduledRunsByTaskId={scheduledTasks.runsByTaskId}
        currentSessionId={activeConv.canonicalSessionId ?? activeConv.id}
        targetParticipants={activeConv.canonicalParticipants ?? []}
        emptyMessage={activeConversationIsBridge ? 'No planning or execution task activity in this chat yet.' : 'No planning or execution task activity in this session yet.'}
        artifacts={artifacts}
        onOpenArtifact={onOpenArtifact}
        onNavigateToResponse={onNavigateToResponse}
      />
      {scheduledTasks.error ? <div className="app-inspector-empty">{scheduledTasks.error}</div> : null}
    </div>
  );
}

function chatDetailPanelPropsEqual(previous: ChatDetailPanelProps, next: ChatDetailPanelProps) {
  return previous.isNativeShell === next.isNativeShell
    && previous.activeDetailTab === next.activeDetailTab
    && previous.activeConv === next.activeConv
    && previous.activeConvHasSubtitle === next.activeConvHasSubtitle
    && previous.activeLastMessage?.time === next.activeLastMessage?.time
    && previous.activeLastMessage?.text === next.activeLastMessage?.text
    && previous.activeLiveTurn === next.activeLiveTurn
    && previous.activeConversationIsBridge === next.activeConversationIsBridge
    && previous.activeBridgeConversationHostNodeId === next.activeBridgeConversationHostNodeId
    && previous.activeBridgeConversationHostUrl === next.activeBridgeConversationHostUrl
    && previous.activeBridgeConversation === next.activeBridgeConversation
    && previous.activeBridgeAwaitingReply === next.activeBridgeAwaitingReply
    && previous.isBridgePolling === next.isBridgePolling
    && previous.lastBridgePollAtLabel === next.lastBridgePollAtLabel
    && previous.activeSessionProject === next.activeSessionProject
    && previous.artifacts === next.artifacts
    && previous.activeArtifactId === next.activeArtifactId
    && previous.onOpenArtifact === next.onOpenArtifact
    && previous.onNavigateToResponse === next.onNavigateToResponse;
}

export const ChatDetailPanel = memo(ChatDetailPanelView, chatDetailPanelPropsEqual);

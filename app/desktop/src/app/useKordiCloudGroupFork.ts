import { useCallback } from 'react';

import { canonicalGroupParticipantsForSession } from '@/app/useKordiAppModelHelpers';
import type { CloudAccount } from '@/features/cloud/authClient';
import {
  type CloudGroupParticipant,
  cloudGroupSelfParticipant,
} from '@/features/cloud/cloudGroupMessages';
import type { UseCloudCollaborationStateResult } from '@/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionState } from '@/kordi-app/types';

type ForkResult = {
  forkedSessionId: string;
  sourceSessionId: string;
  sourceMessageId: string;
};

type UseKordiCloudGroupForkArgs = {
  account: CloudAccount | null;
  loadCanonicalSessionHistory: (
    sessionId: string,
  ) => Promise<CanonicalSessionState | null>;
  recordCloudSessionFork: (
    ...args: Parameters<
      UseCloudCollaborationStateResult['recordCloudSessionFork']
    >
  ) => ReturnType<UseCloudCollaborationStateResult['recordCloudSessionFork']>;
  refreshCanonicalState: () => Promise<void>;
  sendCloudGroupControl: (
    ...args: Parameters<
      UseCloudCollaborationStateResult['sendCloudGroupControl']
    >
  ) => ReturnType<UseCloudCollaborationStateResult['sendCloudGroupControl']>;
};

export function useKordiCloudGroupFork({
  account,
  loadCanonicalSessionHistory,
  recordCloudSessionFork,
  refreshCanonicalState,
  sendCloudGroupControl,
}: UseKordiCloudGroupForkArgs) {
  return useCallback(async (result: ForkResult) => {
    if (!account) return;
    await refreshCanonicalState();
    const state = await loadCanonicalSessionHistory(result.forkedSessionId);
    if (!state) return;
    const forkSession = state.sessions.find(
      (session) => session.id === result.forkedSessionId,
    );
    if (!forkSession) return;
    const forkMetadata =
      forkSession.metadata
      && typeof forkSession.metadata === 'object'
      && !Array.isArray(forkSession.metadata)
        ? (forkSession.metadata as Record<string, unknown>).fork
        : null;
    const forkRecord =
      forkMetadata
      && typeof forkMetadata === 'object'
      && !Array.isArray(forkMetadata)
        ? forkMetadata as Record<string, unknown>
        : null;
    const parentSessionId =
      typeof forkRecord?.forkedFromSessionId === 'string'
      && forkRecord.forkedFromSessionId.trim()
        ? forkRecord.forkedFromSessionId.trim()
        : result.sourceSessionId;
    const parentMessageId =
      typeof forkRecord?.forkedFromMessageId === 'string'
      && forkRecord.forkedFromMessageId.trim()
        ? forkRecord.forkedFromMessageId.trim()
        : result.sourceMessageId;

    await recordCloudSessionFork({
      sourceSessionId: parentSessionId,
      forkSessionId: result.forkedSessionId,
      parentMessageId,
    }).catch((error) => {
      if (
        error
        && typeof error === 'object'
        && 'status' in error
        && (error as { status?: number }).status === 409
      ) {
        return;
      }
      // Best effort: the local fork remains usable if Cloud lineage is not
      // available. Group forks still fall back to the explicit Cloud control
      // below for peers; private self-agent forks use this row for relogin sync.
      return;
    });

    if (forkSession.kind !== 'group') return;
    const participants = canonicalGroupParticipantsForSession(
      state,
      result.forkedSessionId,
    ).filter((participant) => participant.kind === 'human');
    const cloudParticipants: CloudGroupParticipant[] = participants.flatMap(
      (participant) => {
        const accountId =
          participant.humanId?.trim()
          || participant.sourceIdentityId?.trim()
          || '';
        if (!accountId) return [];
        return [{
          accountId,
          displayName: participant.name?.trim() || accountId,
          avatarUrl: participant.profileImageUrl ?? null,
          role: participant.role ?? 'person',
        }];
      },
    );
    if (
      !cloudParticipants.some(
        (participant) => participant.accountId === account.accountId,
      )
    ) {
      cloudParticipants.push(cloudGroupSelfParticipant(account, 'self'));
    }
    const targetAccountIds = [...new Set(
      cloudParticipants
        .map((participant) => participant.accountId)
        .filter(
          (accountId) => accountId && accountId !== account.accountId,
        ),
    )];
    if (targetAccountIds.length === 0) return;

    const fork = {
      forkSessionId: result.forkedSessionId,
      parentSessionId,
      parentMessageId,
      createdAtMs: forkSession.createdAtMs,
    };
    await sendCloudGroupControl({
      targetAccountIds,
      kind: 'session-fork',
      groupId: result.forkedSessionId,
      groupSpaceId: result.forkedSessionId,
      groupTitle: forkSession.title,
      participants: cloudParticipants,
      fork,
    });

    const identityById = new Map(
      state.identities.map((identity) => [identity.id, identity]),
    );
    const accountIdForIdentity = (identityId: string) => {
      const identity = identityById.get(identityId);
      if (!identity) return account.accountId;
      if (identity.kind === 'human') {
        return (
          identity.humanId?.trim()
          || identity.sourceIdentityId?.trim()
          || account.accountId
        );
      }
      if (identity.humanId?.trim()) return identity.humanId.trim();
      if (identity.id.startsWith('agent:cloud:')) {
        return identity.id.slice('agent:cloud:'.length);
      }
      const owner = identity.ownerIdentityId
        ? identityById.get(identity.ownerIdentityId)
        : null;
      return (
        owner?.humanId?.trim()
        || owner?.sourceIdentityId?.trim()
        || account.accountId
      );
    };
    const snapshotMessages = state.messages
      .filter((message) => (
        message.sessionId === result.forkedSessionId
        && message.sourceTransport === 'canonical-fork-snapshot'
      ))
      .sort((left, right) => (
        left.sequenceNum - right.sequenceNum
        || left.createdAtMs - right.createdAtMs
      ));
    for (const message of snapshotMessages) {
      const identity = identityById.get(message.senderIdentityId);
      const senderIsAgent =
        message.messageKind === 'agent-turn'
        || identity?.kind === 'agent'
        || message.senderRole.includes('agent');
      const content =
        message.content
        && typeof message.content === 'object'
        && !Array.isArray(message.content)
          ? message.content as Record<string, unknown>
          : {};
      const deliveryState =
        typeof content.deliveryState === 'string'
        && content.deliveryState.trim()
          ? content.deliveryState.trim()
          : message.status;
      await sendCloudGroupControl({
        targetAccountIds,
        kind: 'group-message',
        groupId: result.forkedSessionId,
        groupSpaceId: result.forkedSessionId,
        groupTitle: forkSession.title,
        participants: cloudParticipants,
        fork,
        message: {
          id: message.id,
          senderAccountId: accountIdForIdentity(message.senderIdentityId),
          text: message.contentText,
          createdAtMs: message.createdAtMs,
          senderKind: senderIsAgent ? 'agent' : 'human',
          senderDisplayName: identity?.displayName ?? null,
          deliveryState,
          replyToMessageId: message.parentMessageId ?? null,
          requestId:
            typeof content.requestId === 'string'
              ? content.requestId
              : null,
          forkSnapshot: true,
        },
      });
    }
  }, [
    account,
    loadCanonicalSessionHistory,
    recordCloudSessionFork,
    refreshCanonicalState,
    sendCloudGroupControl,
  ]);
}

import {
  useCallback,
  type MutableRefObject,
} from 'react';
import type {
  CanonicalSessionState,
} from '@/kordi-app/types';
import {
  beginChatPerformanceSpan,
  chatPerformancePayloadBytes,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  SendCloudMessageAttachmentInput,
} from './authClient';
import {
  uploadComposerAttachments,
} from './cloudAttachments';
import {
  cloudGroupAttachmentReferences,
  cloudGroupForkPayloadFromSessionMetadata,
  cloudGroupManualSessionTitleSnapshot,
  cloudGroupOutgoingParticipantSnapshot,
  cloudGroupParticipantsForCollaborationSession,
  cloudGroupRelatedControlsForSend,
  cloudGroupSelfParticipant,
  cloudGroupTitleForOutgoingControl,
  encodeCloudGroupControl,
  firstCloudGroupSendFailure,
  firstRequiredCloudGroupSendFailure,
  fulfilledCloudGroupSends,
  parseCloudGroupControl,
  requiredCloudGroupControlTargetAccountIds,
} from './cloudGroupMessages';
import type {
  CloudMessageIndex,
} from './cloudMessageIndex';
import {
  CloudGroupOutbox,
  type CloudGroupOutboxEntry,
} from './cloudGroupOutbox';
import {
  cloudGroupOutboxAttachmentSources,
  prepareCloudGroupOutboxEntryAttachments,
} from './cloudGroupOutboxAttachments';
import {
  cleanCloudText,
} from './cloudValue';
import {
  loadSession,
} from './session';
import type {
  SendCloudGroupControlInput,
} from './cloudGroupControl.types';
import {
  useCloudGroupSessionTitleSync,
} from './useCloudGroupSessionTitleSync';

export type {
  SendCloudGroupControlInput,
} from './cloudGroupControl.types';

type CloudGroupControlTransport = {
  client: CloudAuthClient;
  messageIndex: CloudMessageIndex;
  outbox: CloudGroupOutbox | null;
  mergeMessage: (message: CloudMessage) => void;
  persistOutboxDelivery: (
    entry: CloudGroupOutboxEntry,
  ) => Promise<void>;
  claimFreshFallback: (
    sentMessages: readonly CloudMessage[],
    requestMessageId: string,
    token: string,
  ) => Promise<void>;
  syncDiff: () => Promise<void>;
};

type CloudGroupControlCanonicalContext = {
  state: CanonicalSessionState | null | undefined;
  stateRef: MutableRefObject<CanonicalSessionState | null>;
  titleBackfillsRef: MutableRefObject<Set<string>>;
  initialMessagesSettled: boolean;
};

export function useCloudGroupControlSender({
  account,
  transport,
  canonical,
  reportWarning,
}: {
  account: CloudAccount | null;
  transport: CloudGroupControlTransport;
  canonical: CloudGroupControlCanonicalContext;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const {
    client,
    messageIndex,
    outbox,
    mergeMessage,
    persistOutboxDelivery,
    claimFreshFallback,
    syncDiff,
  } = transport;
  const {
    state: canonicalState,
    stateRef: canonicalStateRef,
    titleBackfillsRef,
    initialMessagesSettled,
  } = canonical;

  const sendCloudGroupControl = useCallback(async (
    input: SendCloudGroupControlInput,
  ) => {
    if (!account) throw new Error('Not signed in.');
    const firstAckPerformanceSpan = input.kind === 'group-message'
      ? beginChatPerformanceSpan('cloud-send-to-first-ack')
      : null;
    const relatedGroupControls = cloudGroupRelatedControlsForSend(
      messageIndex.groupRows.map((row) => ({
        envelope: row.envelope,
        createdAtMs: Date.parse(row.wire.createdAt) || 0,
      })),
      {
        groupId: input.groupId,
        groupSpaceId: input.groupSpaceId,
      },
    ).sort((left, right) => left.createdAtMs - right.createdAtMs);
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const actor = input.actor ?? cloudGroupSelfParticipant(
      account,
      input.kind === 'group-message' ? 'person' : 'admin',
    );
    const hasExplicitCurrentParticipantSnapshot =
      input.participants !== undefined
      || input.collaborationParticipants !== undefined;
    const inputParticipants = input.participants?.length
      ? input.participants
      : cloudGroupParticipantsForCollaborationSession(
          account,
          input.collaborationParticipants ?? [],
        );
    const participants = cloudGroupOutgoingParticipantSnapshot({
      currentParticipants: inputParticipants,
      historicalParticipants: relatedGroupControls.flatMap(
        (control) => control.envelope.participants,
      ),
      hasExplicitCurrentSnapshot:
        hasExplicitCurrentParticipantSnapshot,
    });
    const targetAccountIds = [...new Set([
      ...input.targetAccountIds
        .map((value) => value.trim())
        .filter(Boolean),
      ...participants
        .map((participant) => participant.accountId.trim())
        .filter(Boolean),
    ])].filter((accountId) => accountId !== account.accountId);
    const explicitTargetAccountIds = input.targetAccountIds
      .map((value) => value.trim())
      .filter(
        (accountId) =>
          Boolean(accountId) && accountId !== account.accountId,
      );
    const requiredTargetAccountIds =
      requiredCloudGroupControlTargetAccountIds({
        kind: input.kind,
        explicitTargetAccountIds,
        memberLeaves: input.memberLeaves,
      });
    if (targetAccountIds.length === 0) {
      finishChatPerformanceSpan(firstAckPerformanceSpan, {
        resultClass: 'failed',
        recipientCount: 0,
      });
      return;
    }
    const groupTitle = cloudGroupTitleForOutgoingControl({
      kind: input.kind,
      groupTitle: input.groupTitle,
      relatedGroupTitles: relatedGroupControls.map(
        (control) => control.envelope.groupTitle,
      ),
    });
    const currentCanonicalState = canonicalStateRef.current;
    const sessionTitle = cloudGroupManualSessionTitleSnapshot({
      session: currentCanonicalState?.sessions.find(
        (candidate) => candidate.id === input.groupId,
      ),
      identities: currentCanonicalState?.identities,
    });
    const forkFromSessionMetadata = input.kind === 'group-message'
      ? cloudGroupForkPayloadFromSessionMetadata(
          canonicalStateRef.current?.sessions.find(
            (candidate) => candidate.id === input.groupId,
          )?.metadata,
          input.groupId,
        )
      : null;
    const buildPayload = (
      uploadedAttachments: SendCloudMessageAttachmentInput[],
    ) => {
      const groupMessageAttachments = uploadedAttachments.length > 0
        ? uploadedAttachments
        : input.message?.attachments ?? [];
      const message = input.message
        ? {
            ...input.message,
            senderAccountId:
              input.message.senderAccountId?.trim()
              || account.accountId,
            attachments: input.message.voiceMessage
              ? undefined
              : groupMessageAttachments.length > 0
              ? cloudGroupAttachmentReferences(
                  groupMessageAttachments,
                )
              : input.message.attachments,
            ...(input.message.voiceMessage && groupMessageAttachments[0] ? {
              voiceMessage: {
                ...input.message.voiceMessage,
                mediaId: groupMessageAttachments[0].attachmentId,
              },
            } : {}),
          }
        : null;
      const envelope = encodeCloudGroupControl({
        kind: input.kind,
        groupId: input.groupId,
        groupSpaceId: input.groupSpaceId ?? null,
        groupTitle,
        createdByAccountId:
          input.createdByAccountId?.trim() || account.accountId,
        actor,
        participants,
        sessionTitle,
        sessionTitleSyncOnly: input.sessionTitleSyncOnly,
        memberJoins: input.memberJoins,
        memberLeaves: input.memberLeaves,
        fork: input.fork ?? forkFromSessionMetadata,
        message,
      });
      return { message, envelope };
    };
    const initialPayload = buildPayload([]);
    const recordFirstAck = (
      envelope: string,
      attachmentCount: number,
    ) => finishChatPerformanceSpan(firstAckPerformanceSpan, () => ({
      resultClass: 'success',
      recipientCount: targetAccountIds.length,
      attachmentCount,
      payloadBytes: chatPerformancePayloadBytes(envelope),
    }));
    const forkCreatedAtMs =
      input.fork?.createdAtMs
      ?? forkFromSessionMetadata?.createdAtMs;
    const clientCreatedAtMs =
      typeof initialPayload.message?.createdAtMs === 'number'
      && Number.isFinite(initialPayload.message.createdAtMs)
        ? initialPayload.message.createdAtMs
        : typeof forkCreatedAtMs === 'number'
          && Number.isFinite(forkCreatedAtMs)
          ? forkCreatedAtMs
          : null;
    const clientCreatedAt = clientCreatedAtMs !== null
      ? new Date(clientCreatedAtMs).toISOString()
      : null;
    const canonicalMessageId = cleanCloudText(
      initialPayload.message?.id,
    );
    if (
      input.kind === 'group-message'
      && canonicalMessageId
      && outbox
    ) {
      await outbox.restore();
      const outboxEntry = {
        canonicalMessageId,
        sessionId: input.groupId,
        envelope: initialPayload.envelope,
        trackCanonicalDelivery:
          initialPayload.message?.forkSnapshot !== true,
        pendingAttachments: cloudGroupOutboxAttachmentSources(
          input.attachments ?? [],
        ),
        clientCreatedAt,
        pendingRecipientIds: targetAccountIds,
        deliveredRecipientIds: [],
        attemptsByRecipientId: {},
        nextAttemptAtMs: 0,
      };
      const queued = input.retryFailed
        ? await outbox.requeueFailed(outboxEntry)
        : await outbox.enqueue(outboxEntry);
      if (!queued) {
        finishChatPerformanceSpan(firstAckPerformanceSpan, {
          resultClass: 'duplicate',
          recipientCount: targetAccountIds.length,
        });
        return;
      }
      let sentAny = false;
      const sentMessages: CloudMessage[] = [];
      let preparedEntry: Promise<CloudGroupOutboxEntry> | null = null;
      const outcome = await outbox.deliver(
        canonicalMessageId,
        async ({ recipientId, clientMessageId, entry }) => {
          preparedEntry ??= prepareCloudGroupOutboxEntryAttachments({
            outbox,
            entry,
            upload: (attachments) => uploadComposerAttachments({
              token: session.token,
              client,
              attachments,
            }),
          });
          const ready = await preparedEntry;
          const readyMessage = parseCloudGroupControl(ready.envelope)?.message;
          const readyVoiceMessage = readyMessage?.voiceMessage?.mediaId
            ? { ...readyMessage.voiceMessage, mediaId: readyMessage.voiceMessage.mediaId }
            : null;
          const sentMessage = await client.sendMessage(
            session.token,
            recipientId,
            ready.envelope,
            {
              sessionId: ready.sessionId,
              attachments: ready.attachments,
              clientCreatedAt: ready.clientCreatedAt,
              clientMessageId,
              messageKind: readyMessage?.messageKind,
              voiceMessage: readyVoiceMessage,
              conversationKind: 'group',
              memberAccountIds: targetAccountIds,
            },
          );
          recordFirstAck(
            ready.envelope,
            ready.attachments?.length ?? 0,
          );
          sentAny = true;
          sentMessages.push(sentMessage);
          mergeMessage(sentMessage);
        },
        { force: true },
      );
      if (outcome) {
        await persistOutboxDelivery(outcome).catch((error) => {
          reportWarning(
            '[cloud-group-outbox] failed to persist delivery status',
            error,
          );
        });
      }
      if (sentAny) {
        await Promise.all([
          claimFreshFallback(
            sentMessages,
            canonicalMessageId,
            session.token,
          ),
          syncDiff().catch(() => {}),
        ]);
      }
      return;
    }
    const uploadedAttachments = input.attachments?.length
      ? await uploadComposerAttachments({
          token: session.token,
          client,
          attachments: input.attachments,
        })
      : [];
    const payload = buildPayload(uploadedAttachments);
    const payloadVoiceMessage = payload.message?.voiceMessage?.mediaId
      ? { ...payload.message.voiceMessage, mediaId: payload.message.voiceMessage.mediaId }
      : null;
    const results = await Promise.allSettled(
      targetAccountIds.map(async (peerId) => {
        const sentMessage = await client.sendMessage(
          session.token,
          peerId,
          payload.envelope,
          {
            sessionId: input.groupId,
            attachments: uploadedAttachments,
            messageKind: payload.message?.messageKind,
            voiceMessage: payloadVoiceMessage,
            ...(clientCreatedAt ? { clientCreatedAt } : {}),
            conversationKind: 'group',
            memberAccountIds: targetAccountIds,
          },
        );
        recordFirstAck(
          payload.envelope,
          uploadedAttachments.length,
        );
        return sentMessage;
      }),
    );
    const sent = fulfilledCloudGroupSends(results);
    sent.forEach(mergeMessage);
    const requiredControlFailure =
      firstRequiredCloudGroupSendFailure(
        results,
        targetAccountIds,
        requiredTargetAccountIds,
      );
    if (requiredControlFailure) {
      finishChatPerformanceSpan(firstAckPerformanceSpan, {
        resultClass: 'failed',
        recipientCount: targetAccountIds.length,
        errorCount: 1,
      });
      throw requiredControlFailure.reason instanceof Error
        ? requiredControlFailure.reason
        : new Error(String(
            requiredControlFailure.reason
            || 'Required group control failed.',
          ));
    }
    if (sent.length > 0) {
      if (input.kind === 'group-message' && canonicalMessageId) {
        await Promise.all([
          claimFreshFallback(
            sent,
            canonicalMessageId,
            session.token,
          ),
          syncDiff(),
        ]);
        return;
      }
      await syncDiff();
      return;
    }
    const firstFailure = firstCloudGroupSendFailure(results);
    const failureMessage = typeof firstFailure === 'string'
      ? firstFailure
      : 'Group message failed.';
    finishChatPerformanceSpan(firstAckPerformanceSpan, {
      resultClass: 'failed',
      recipientCount: targetAccountIds.length,
      errorCount: targetAccountIds.length,
    });
    throw firstFailure instanceof Error
      ? firstFailure
      : new Error(failureMessage);
  }, [
    account,
    canonicalStateRef,
    claimFreshFallback,
    client,
    mergeMessage,
    messageIndex,
    outbox,
    persistOutboxDelivery,
    reportWarning,
    syncDiff,
  ]);

  useCloudGroupSessionTitleSync({
    account,
    canonicalState,
    messageIndex,
    initialMessagesSettled,
    titleBackfillsRef,
    sendGroupControl: sendCloudGroupControl,
    reportWarning,
  });

  return sendCloudGroupControl;
}

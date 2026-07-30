import {
  useEffect,
  type MutableRefObject,
} from 'react';
import type {
  CanonicalSessionState,
} from '@/kordi-app/types';
import type {
  CloudAccount,
} from './authClient';
import type {
  SendCloudGroupControlInput,
} from './cloudGroupControl.types';
import {
  cloudGroupManualSessionTitleSnapshot,
  cloudGroupRelatedControlsForSend,
  cloudGroupSelfParticipant,
} from './cloudGroupMessages';
import type {
  CloudMessageIndex,
} from './cloudMessageIndex';
import {
  cleanCloudText,
  cloudObjectContent,
} from './cloudValue';

export function useCloudGroupSessionTitleSync({
  account,
  canonicalState,
  messageIndex,
  initialMessagesSettled,
  titleBackfillsRef,
  sendGroupControl,
  reportWarning,
}: {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null | undefined;
  messageIndex: CloudMessageIndex;
  initialMessagesSettled: boolean;
  titleBackfillsRef: MutableRefObject<Set<string>>;
  sendGroupControl: (
    input: SendCloudGroupControlInput,
  ) => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  useEffect(() => {
    if (
      !account
      || !canonicalState
      || !initialMessagesSettled
    ) return;
    const controls = messageIndex.groupRows.map((row) => ({
      envelope: row.envelope,
      createdAtMs: Date.parse(row.wire.createdAt) || 0,
    }));
    const identityById = new Map(
      canonicalState.identities.map((identity) => [
        identity.id,
        identity,
      ]),
    );
    for (const session of canonicalState.sessions) {
      if (session.kind !== 'group') continue;
      const sessionTitle = cloudGroupManualSessionTitleSnapshot({
        session,
        identities: canonicalState.identities,
      });
      if (!sessionTitle) continue;
      const metadata = cloudObjectContent(session.metadata);
      const groupSpaceId = cleanCloudText(
        typeof metadata.groupSpaceId === 'string'
          ? metadata.groupSpaceId
          : typeof metadata.groupId === 'string'
            ? metadata.groupId
            : session.id,
      ) || session.id;
      const relatedControls = cloudGroupRelatedControlsForSend(
        controls,
        { groupId: session.id, groupSpaceId },
      ).sort((left, right) => left.createdAtMs - right.createdAtMs);
      const latestControl =
        relatedControls[relatedControls.length - 1]?.envelope;
      if (!latestControl) continue;
      const targetAccountIds = [...new Set(
        latestControl.participants
          .map((participant) => participant.accountId.trim())
          .filter(
            (accountId) =>
              Boolean(accountId)
              && accountId !== account.accountId,
          ),
      )];
      if (targetAccountIds.length === 0) continue;
      const backfillKey = `${account.accountId}:${session.id}`;
      if (titleBackfillsRef.current.has(backfillKey)) continue;

      const creatorIdentityId = cleanCloudText(
        typeof metadata.groupCreatorIdentityId === 'string'
          ? metadata.groupCreatorIdentityId
          : session.createdByIdentityId,
      );
      const adminIdentityIds = new Set([
        creatorIdentityId,
        ...(Array.isArray(metadata.adminIdentityIds)
          ? metadata.adminIdentityIds.filter(
              (identityId): identityId is string =>
                typeof identityId === 'string',
            )
          : []),
      ].map((identityId) => identityId.trim()).filter(Boolean));
      const selfIdentityId =
        canonicalState.profile.humanIdentityId?.trim() ?? '';
      const actor = cloudGroupSelfParticipant(
        account,
        adminIdentityIds.has(selfIdentityId) ? 'admin' : 'person',
      );
      const creatorIdentity = identityById.get(creatorIdentityId);
      const createdByAccountId = cleanCloudText(
        creatorIdentity?.humanId,
      )
        || cleanCloudText(creatorIdentity?.sourceIdentityId)
        || latestControl.createdByAccountId;

      titleBackfillsRef.current.add(backfillKey);
      void sendGroupControl({
        targetAccountIds,
        kind: 'session-title-update',
        groupId: session.id,
        groupSpaceId,
        groupTitle: sessionTitle.title,
        createdByAccountId,
        actor,
        participants: latestControl.participants,
        sessionTitleSyncOnly: true,
      }).catch((error) => {
        titleBackfillsRef.current.delete(backfillKey);
        reportWarning(
          '[cloud-group-session-title] failed to backfill title',
          error,
        );
      });
    }
  }, [
    account,
    canonicalState,
    initialMessagesSettled,
    messageIndex,
    reportWarning,
    sendGroupControl,
    titleBackfillsRef,
  ]);
}

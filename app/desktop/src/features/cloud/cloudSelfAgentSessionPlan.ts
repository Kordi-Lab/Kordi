import {
  deriveSessionTitle,
  incomingSessionTitleWins,
  sessionTitleMetadata,
  titleSourceFromMetadata,
} from '@/features/chat/sessionTitlePolicy';
import type {
  CanonicalSessionState,
  OpenCanonicalSessionRequest,
} from '@/kordi-app/types';
import type {
  CloudSessionForkSummary,
  CloudSessionTitle,
} from './authClient';

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function canonicalMessageId(cloudMessageId: string) {
  return `msg:cloud:self:${cloudMessageId}`;
}

function configuredAgentIdentityId(
  state: CanonicalSessionState,
  metadata: Record<string, unknown>,
) {
  const configuredAgentId = cleanText(
    typeof metadata.agentId === 'string' ? metadata.agentId : null,
  );
  if (
    metadata.createdFrom !== 'chat-create-flow'
    || !cleanText(typeof metadata.cloudAgentId === 'string' ? metadata.cloudAgentId : null)
    || !configuredAgentId
  ) return null;
  return state.identities.find((identity) => {
    const identityMetadata = identity.metadata
      && typeof identity.metadata === 'object'
      && !Array.isArray(identity.metadata)
      ? identity.metadata as Record<string, unknown>
      : {};
    return identity.kind === 'agent' && (
      cleanText(identity.agentId) === configuredAgentId
      || cleanText(
        typeof identityMetadata.agentId === 'string'
          ? identityMetadata.agentId
          : null,
      ) === configuredAgentId
    );
  })?.id ?? null;
}

export function createCloudSelfAgentSessionPlanner({
  state,
  forksBySessionId,
  cloudTitlesBySessionId,
  localHumanIdentityId,
  agentIdentityId,
}: {
  state: CanonicalSessionState;
  forksBySessionId: Record<string, CloudSessionForkSummary>;
  cloudTitlesBySessionId: Readonly<Record<string, CloudSessionTitle>>;
  localHumanIdentityId: string;
  agentIdentityId: string;
}) {
  const requestsById =
    new Map<string, OpenCanonicalSessionRequest>();
  const existingById =
    new Map(state.sessions.map((session) => [session.id, session]));
  const configuredIdentityBySessionId = new Map<string, string>();

  const ensure = (
    sessionId: string,
    seed: string,
    generatedFromMessageId?: string | null,
    updatedAtMs?: number,
    isForkSnapshot = false,
  ) => {
    const cloudTitle = cloudTitlesBySessionId[sessionId];
    const fork = forksBySessionId[sessionId];
    const generatedTitle = deriveSessionTitle(seed);
    const title = cloudTitle?.title
      ?? generatedTitle
      ?? (fork ? 'New fork' : 'New chat');
    const cloudTitleMetadata = cloudTitle ? {
      sessionTitleSource: cloudTitle.titleSource,
      titleSource: cloudTitle.titleSource,
      sessionTitleRevision: cloudTitle.titleRevision,
      sessionTitlePolicyVersion: cloudTitle.titlePolicyVersion,
      sessionTitleUpdatedAtMs: cloudTitle.updatedAtMs,
      sessionTitleUpdatedByAccountId: cloudTitle.updatedByAccountId,
      ...(cloudTitle.titleGeneratedFromMessageId
        ? {
            sessionTitleGeneratedFromMessageId:
              cloudTitle.titleGeneratedFromMessageId,
          }
        : {}),
    } : null;
    const planned = requestsById.get(sessionId);
    if (planned) {
      const plannedMetadata =
        planned.metadata
        && typeof planned.metadata === 'object'
        && !Array.isArray(planned.metadata)
          ? planned.metadata as Record<string, unknown>
          : {};
      const plannedSource = titleSourceFromMetadata(
        plannedMetadata,
        planned.title,
      );
      const plannedUpdatedAtMs =
        typeof plannedMetadata.sessionTitleUpdatedAtMs === 'number'
          ? plannedMetadata.sessionTitleUpdatedAtMs
          : 0;
      const plannedRevision =
        typeof plannedMetadata.sessionTitleRevision === 'number'
          ? plannedMetadata.sessionTitleRevision
          : 0;
      const plannedUpdatedByAccountId =
        typeof plannedMetadata.sessionTitleUpdatedByAccountId
          === 'string'
          ? plannedMetadata.sessionTitleUpdatedByAccountId
          : null;
      const cloudWinsPlanned = Boolean(cloudTitle)
        && incomingSessionTitleWins(
          {
            titleSource: plannedSource,
            titleRevision: plannedRevision,
            updatedAtMs: plannedUpdatedAtMs,
            updatedByAccountId: plannedUpdatedByAccountId,
          },
          cloudTitle,
        );
      if (
        cloudWinsPlanned
        || (generatedTitle && plannedSource === 'placeholder')
      ) {
        requestsById.set(sessionId, {
          ...planned,
          title,
          metadata: {
            ...plannedMetadata,
            ...(cloudTitleMetadata ?? sessionTitleMetadata(
              'auto',
              { generatedFromMessageId, updatedAtMs },
            )),
          },
        });
      }
      return;
    }

    const existingSession = existingById.get(sessionId);
    const existingMetadata =
      existingSession?.metadata
      && typeof existingSession.metadata === 'object'
      && !Array.isArray(existingSession.metadata)
        ? existingSession.metadata as Record<string, unknown>
        : {};
    const existingSource = titleSourceFromMetadata(
      existingMetadata,
      existingSession?.title,
    );
    const existingUpdatedAtMs =
      typeof existingMetadata.sessionTitleUpdatedAtMs === 'number'
        ? existingMetadata.sessionTitleUpdatedAtMs
        : 0;
    const existingRevision =
      typeof existingMetadata.sessionTitleRevision === 'number'
        ? existingMetadata.sessionTitleRevision
        : 0;
    const existingUpdatedByAccountId =
      typeof existingMetadata.sessionTitleUpdatedByAccountId
        === 'string'
        ? existingMetadata.sessionTitleUpdatedByAccountId
        : null;
    const existingGeneratedFromMessageId =
      typeof existingMetadata.sessionTitleGeneratedFromMessageId
        === 'string'
        ? existingMetadata.sessionTitleGeneratedFromMessageId.trim()
        : '';
    const configuredIdentityId = configuredAgentIdentityId(state, existingMetadata);
    if (configuredIdentityId) {
      configuredIdentityBySessionId.set(sessionId, configuredIdentityId);
    }
    const shouldRepairConfiguredIdentity = Boolean(configuredIdentityId) && (
      existingSession?.kind !== 'direct-agent'
      || existingSession.primaryIdentityId !== configuredIdentityId
    );
    const currentGeneratedFromMessageId =
      generatedFromMessageId?.trim() ?? '';
    const cloudWinsExisting = Boolean(cloudTitle)
      && incomingSessionTitleWins(
        {
          titleSource: existingSource,
          titleRevision: existingRevision,
          updatedAtMs: existingUpdatedAtMs,
          updatedByAccountId: existingUpdatedByAccountId,
        },
        cloudTitle,
      );
    const generatedFromCurrentSnapshot =
      Boolean(currentGeneratedFromMessageId)
      && (
        existingGeneratedFromMessageId
          === currentGeneratedFromMessageId
        || existingGeneratedFromMessageId
          === canonicalMessageId(currentGeneratedFromMessageId)
      );
    const cloudTitleProtectsForkTitle =
      cloudWinsExisting
      && cloudTitle?.titleSource !== 'auto'
      && cloudTitle?.titleSource !== 'placeholder';
    const shouldResetInheritedForkTitle =
      Boolean(fork)
      && isForkSnapshot
      && existingSource === 'auto'
      && (
        !existingGeneratedFromMessageId
        || generatedFromCurrentSnapshot
      )
      && !cloudTitleProtectsForkTitle;
    const shouldUpdateExistingTitle =
      cloudWinsExisting
      || shouldResetInheritedForkTitle
      || (
        Boolean(generatedTitle)
        && existingSource === 'placeholder'
      );
    const existingFork =
      existingMetadata.fork
      && typeof existingMetadata.fork === 'object'
      && !Array.isArray(existingMetadata.fork)
        ? existingMetadata.fork as Record<string, unknown>
        : null;
    const existingForkAliases =
      Array.isArray(existingFork?.forkedFromMessageAliases)
        ? existingFork.forkedFromMessageAliases
            .filter((
              value,
            ): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
    const forkedFromMessageAliases = fork?.parentMessageId
      ? [...new Set([
          ...existingForkAliases,
          fork.parentMessageId,
        ])]
      : existingForkAliases;
    const metadata: Record<string, unknown> = {
      ...existingMetadata,
      cloudSelfAgentSession: true,
      ...(shouldUpdateExistingTitle || !existingSession
        ? shouldResetInheritedForkTitle
          ? sessionTitleMetadata('placeholder', { updatedAtMs })
          : cloudTitleMetadata ?? sessionTitleMetadata(
              generatedTitle ? 'auto' : 'placeholder',
              { generatedFromMessageId, updatedAtMs },
            )
        : {}),
      ...(fork
        ? {
            fork: {
              ...existingFork,
              forkedFromSessionId: fork.parentSessionId,
              ...(fork.parentMessageId
                ? { forkedFromMessageId: fork.parentMessageId }
                : {}),
              ...(forkedFromMessageAliases.length > 0
                ? { forkedFromMessageAliases }
                : {}),
              forkMode: 'private-local',
              contextPolicy: 'prefix-through-message',
              boundary: 'inherited-history-reference-only',
            },
          }
        : {}),
    };
    if (shouldResetInheritedForkTitle) {
      delete metadata.sessionTitleGeneratedFromMessageId;
    }
    const existingHasFork =
      Boolean(fork)
      && existingFork?.forkedFromSessionId === fork?.parentSessionId
      && (
        !fork?.parentMessageId
        || existingFork?.forkedFromMessageId === fork.parentMessageId
      );
    const existingHasCompleteForkContract =
      existingHasFork
      && (
        !fork?.parentMessageId
        || existingForkAliases.includes(fork.parentMessageId)
      )
      && existingFork?.forkMode === 'private-local'
      && existingFork?.contextPolicy === 'prefix-through-message'
      && existingFork?.boundary
        === 'inherited-history-reference-only';
    if (
      existingSession
      && (!fork || existingHasCompleteForkContract)
      && !shouldUpdateExistingTitle
      && !shouldRepairConfiguredIdentity
    ) return;
    const primaryIdentityId = configuredIdentityId ?? agentIdentityId;
    requestsById.set(sessionId, {
      id: sessionId,
      kind: configuredIdentityId ? 'direct-agent' : 'self-agent',
      title: shouldResetInheritedForkTitle
        ? 'New fork'
        : shouldUpdateExistingTitle
          ? title
          : cleanText(existingSession?.title) || title,
      status: 'active',
      createdByIdentityId: localHumanIdentityId,
      primaryIdentityId,
      participantIdentityIds: [primaryIdentityId],
      metadata,
    });
  };

  return {
    ensure,
    get requests(): OpenCanonicalSessionRequest[] {
      return [...requestsById.values()];
    },
    agentIdentityIdForSession(sessionId: string) {
      return configuredIdentityBySessionId.get(sessionId) ?? agentIdentityId;
    },
    existingById,
  };
}

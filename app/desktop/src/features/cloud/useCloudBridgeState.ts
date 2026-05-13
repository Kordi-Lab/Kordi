import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  appendCanonicalMessage,
  cancelDesktopChatTurn,
  fetchDesktopChatTurnState,
  openOrCreateCanonicalSession,
  renameCanonicalSession,
  startDesktopChatMessage,
  updateCanonicalSessionMetadata,
  upsertCanonicalIdentity,
  upsertCanonicalMessage,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
  DesktopBridgeSessionParticipant,
  DesktopBridgeState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import { markOptimisticCanonicalMessageFailed } from '@/features/chat/messageActions/optimistic';

import {
  CloudAuthClient,
  cloudWebSocketUrl,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudMessage,
} from './authClient';
import {
  buildCloudDesktopBridgeState,
  cloudContactsToCanonicalIdentityRequests,
  cloudGroupParticipantContacts,
  cloudPeerAccountIdFromConversationId,
  isCloudBridgeHostId,
  mergeCloudBridgeState,
} from './cloudBridgeState';
import {
  CLOUD_AGENT_RUNTIME_SESSION_PREFIX,
  buildCloudAgentPromptWithSharedContext,
  cloudMessageMentionsLocalAgent,
  encodeCloudAgentCancel,
  encodeCloudAgentResponse,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import {
  cloudAgentRuntimeRouteForSession,
  cloudAgentRuntimeSessionId,
} from './cloudAgentRuntime';
import {
  cloudGroupAgentConversationId,
  cloudGroupAgentMentionHasResponse,
  cloudGroupAgentMentionResponseState,
  cloudGroupAgentOfflineNoticeRequest,
  cloudGroupAgentRequestingNoticeMessage,
  cloudGroupAgentRequestingNoticeRequest,
  cloudGroupAgentResponseTargetAccountIds,
  cloudGroupControlMessagesForAccount,
  cloudGroupControlReplayKey,
  cloudGroupDeliveryStateFromMessages,
  cloudGroupIdFromAgentConversationId,
  cloudGroupIdentityRequest,
  cloudGroupLocalAgentRequestAlreadyHandled,
  cloudGroupMessageReadPeerIds,
  cloudGroupParticipantsForBridgeSessionParticipants,
  cloudGroupPeerIdsFromContactsAndRequests,
  cloudGroupPeerIdsFromMessages,
  cloudGroupSelfParticipant,
  cloudGroupTitleForOutgoingControl,
  cloudGroupTitleUpdateNoticeRequest,
  cloudGroupUnreadCountsBySessionId,
  cloudSessionTitleUpdateNoticeRequest,
  cloudSessionTitleUpdateTitle,
  cloudGroupUniqueParticipants,
  cloudGroupRelatedControlsForSend,
  cloudGroupNonGenericTitle,
  encodeCloudGroupControl,
  firstCloudGroupSendFailure,
  fulfilledCloudGroupSends,
  parseCloudGroupControl,
  shouldApplyCloudGroupTitleUpdate,
  shouldCountCloudGroupMessageUnread,
  type CloudGroupControlEnvelope,
  type CloudGroupParticipant,
} from './cloudGroupMessages';
import { loadSession } from './session';
import { CLOUD_HOST_SENTINEL, useCloudContacts } from './useCloudContacts';

export const CLOUD_AGENT_MENTION_WINDOW_MS = 10 * 60_000;
export const CLOUD_AGENT_TURN_POLL_MS = 500;
export const CLOUD_AGENT_TURN_TIMEOUT_MS = 10 * 60_000;
export const CLOUD_MESSAGES_REFRESH_MS = 500;
export const CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS = 15_000;

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

type CloudAgentMentionCandidate = {
  requestMessage: CanonicalSessionMessage;
  targetAccountId: string;
  targetHumanDisplayName: string;
  targetAgentDisplayName: string;
};

function cloudAgentMentionCandidates(state: CanonicalSessionState, accountId: string): CloudAgentMentionCandidate[] {
  const identityByHumanId = new Map<string, CanonicalIdentity>();
  const identityById = new Map(state.identities.map((identity) => [identity.id, identity]));
  for (const identity of state.identities) {
    const humanId = cleanText(identity.humanId) || cleanText(identity.bridgeNodeId);
    if (identity.kind === 'human' && humanId) identityByHumanId.set(humanId, identity);
  }

  return state.messages.flatMap((message): CloudAgentMentionCandidate[] => {
    if (message.senderRole !== 'user' || message.status === 'failed') return [];
    const content = objectContent(message.content);
    const mentions = Array.isArray(content.mentions) ? content.mentions : [];
    return mentions.flatMap((rawMention): CloudAgentMentionCandidate[] => {
      const mention = objectContent(rawMention);
      if (cleanText(typeof mention.targetKind === 'string' ? mention.targetKind : null) !== 'bridge-agent') return [];
      if (cleanText(typeof mention.bridgeHostId === 'string' ? mention.bridgeHostId : null) !== CLOUD_HOST_SENTINEL) return [];
      const targetAccountId = cleanText(typeof mention.humanId === 'string' ? mention.humanId : null)
        || cleanText(typeof mention.nodeId === 'string' ? mention.nodeId : null);
      if (!targetAccountId || targetAccountId === accountId) return [];
      const humanIdentity = identityByHumanId.get(targetAccountId);
      const agentIdentity = identityById.get(`agent:cloud:${targetAccountId}`);
      const targetHumanDisplayName = cleanText(humanIdentity?.displayName)
        || cleanText(typeof mention.label === 'string' ? mention.label.replace(/'?sKordi$/u, '') : null)
        || targetAccountId;
      const targetAgentDisplayName = cleanText(agentIdentity?.displayName) || `${targetHumanDisplayName}'s Kordi`;
      return [{ requestMessage: message, targetAccountId, targetHumanDisplayName, targetAgentDisplayName }];
    });
  });
}

function cloudGroupRequestSlotMatches(message: CanonicalSessionMessage, noticeId: string) {
  return message.id === noticeId;
}

function cloudGroupOfflinePlaceholderMatches(message: CanonicalSessionMessage, noticeId: string) {
  return cloudGroupRequestSlotMatches(message, noticeId) && message.sourceTransport === 'cloud-group-agent-offline';
}

function cloudGroupAgentResponseMatches(
  message: CanonicalSessionMessage,
  candidate: CloudAgentMentionCandidate,
) {
  if (message.senderIdentityId !== `agent:cloud:${candidate.targetAccountId}`) return false;
  if (message.sourceTransport !== 'cloud-group-agent') return false;
  const content = objectContent(message.content);
  const linkedRequestId = cleanText(message.parentMessageId)
    || cleanText(typeof content.requestId === 'string' ? content.requestId : null)
    || cleanText(typeof content.replyToMessageId === 'string' ? content.replyToMessageId : null);
  return linkedRequestId === candidate.requestMessage.id;
}

function removeCloudGroupOfflinePlaceholder(
  current: CanonicalSessionState | null,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter((message) => !cloudGroupOfflinePlaceholderMatches(message, noticeId));
  return nextMessages.length === current.messages.length ? current : { ...current, messages: nextMessages };
}

function setCloudGroupRequestPlaceholderProcessing(
  current: CanonicalSessionState | null,
  candidate: CloudAgentMentionCandidate,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  let changed = false;
  const updatedAtMs = Date.now();
  const nextMessages = current.messages.flatMap((message): CanonicalSessionMessage[] => {
    if (cloudGroupRequestSlotMatches(message, noticeId)) {
      const content = objectContent(message.content);
      changed = true;
      return [{
        ...message,
        contentText: 'processing...',
        content: {
          ...content,
          deliveryState: 'processing',
          timestampMs: typeof content.timestampMs === 'number' ? content.timestampMs : updatedAtMs,
        },
        status: 'processing',
        updatedAtMs,
      }];
    }
    if (cloudGroupAgentResponseMatches(message, candidate)) {
      changed = true;
      return [];
    }
    return [message];
  });
  return changed ? { ...current, messages: nextMessages } : current;
}

function appendCloudGroupRequestingPlaceholder(
  current: CanonicalSessionState | null,
  candidate: CloudAgentMentionCandidate,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current || current.messages.some((message) => message.id === noticeId)) return current;
  const createdAtMs = Date.now();
  return {
    ...current,
    messages: [
      ...current.messages,
      cloudGroupAgentRequestingNoticeMessage({
        sessionId: candidate.requestMessage.sessionId,
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        targetAgentDisplayName: candidate.targetAgentDisplayName,
        createdAtMs,
        sequenceNum: candidate.requestMessage.sequenceNum + 1,
      }),
    ],
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isRecentCloudAgentMention(createdAt: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= CLOUD_AGENT_MENTION_WINDOW_MS;
}

function isCloudAgentProcessingPlaceholderText(text: string): boolean {
  return /^processing[.\s…]*$/iu.test(text.trim());
}

function cloudMessageListsEqual(left: CloudMessage[] = [], right: CloudMessage[] = []): boolean {
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    return Boolean(other)
      && message.messageId === other.messageId
      && message.fromAccountId === other.fromAccountId
      && message.toAccountId === other.toAccountId
      && message.body === other.body
      && message.createdAt === other.createdAt
      && message.deliveredAt === other.deliveredAt
      && message.readAt === other.readAt
      && message.direction === other.direction;
  });
}

function cloudMessagesByPeerEqual(
  left: Record<string, CloudMessage[]>,
  right: Record<string, CloudMessage[]>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && cloudMessageListsEqual(left[key], right[key]));
}

async function waitForCloudAgentTurn(
  turnId: string,
  onSnapshot?: (snapshot: DesktopChatTurnSnapshot) => void,
) {
  const deadline = Date.now() + CLOUD_AGENT_TURN_TIMEOUT_MS;
  let latest = await fetchDesktopChatTurnState(turnId);
  onSnapshot?.(latest);
  while (!latest.completed && Date.now() < deadline) {
    await wait(CLOUD_AGENT_TURN_POLL_MS);
    latest = await fetchDesktopChatTurnState(turnId);
    onSnapshot?.(latest);
  }
  return latest;
}

export type SendCloudGroupControlInput = {
  targetAccountIds: string[];
  kind: CloudGroupControlEnvelope['kind'];
  groupId: string;
  groupSpaceId?: string | null;
  groupTitle?: string | null;
  createdByAccountId?: string | null;
  actor?: CloudGroupParticipant | null;
  participants?: CloudGroupParticipant[];
  bridgeParticipants?: DesktopBridgeSessionParticipant[];
  message?: CloudGroupControlEnvelope['message'];
};

export type UseCloudBridgeStateResult = {
  cloudBridgeState: DesktopBridgeState | null;
  setCloudBridgeState: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  mergedBridgeState: DesktopBridgeState | null;
  sendCloudBridgeMessage(conversationId: string, text: string): Promise<void>;
  sendCloudGroupControl(input: SendCloudGroupControlInput): Promise<void>;
  cancelCloudBridgeAgentRequest(conversationId: string, requestId: string): Promise<void>;
  refreshCloudBridgeMessages(): Promise<void>;
};

function applyCloudAgentRuntimeRouteToState(
  state: DesktopBridgeState | null,
  route: DesktopChatMessageRoute | null,
): DesktopBridgeState | null {
  if (!state) return state;
  return {
    ...state,
    hosts: state.hosts.map((host) => {
      if (!isCloudBridgeHostId(host.id)) return host;
      return {
        ...host,
        agents: host.agents.map((agent) => (
          agent.id === 'cloud-local-agent'
            ? {
                ...agent,
                defaultModel: route?.model ?? null,
                defaultAuthProvider: route?.authProvider ?? null,
                defaultAuthChoice: route?.authChoice ?? null,
                thinking: route?.thinking ?? null,
              }
            : agent
        )),
      };
    }),
  };
}

export function useCloudBridgeState({
  account,
  baseBridgeState,
  activeConversationId,
  canonicalSessionState,
  setCanonicalSessionState,
  incrementLocalSessionUnread,
  cloudAgentRuntimeRoutesBySessionId,
}: {
  account: CloudAccount | null;
  baseBridgeState: DesktopBridgeState | null;
  activeConversationId?: string | null;
  canonicalSessionState?: CanonicalSessionState | null;
  setCanonicalSessionState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  incrementLocalSessionUnread?: (sessionId: string, count?: number) => void;
  cloudAgentRuntimeRoutesBySessionId?: Record<string, DesktopChatMessageRoute>;
}): UseCloudBridgeStateResult {
  const client = useMemo<CloudAuthClient>(() => defaultCloudAuthClient(), []);
  const contacts = useCloudContacts(account);
  const [messagesByPeer, setMessagesByPeer] = useState<Record<string, CloudMessage[]>>({});
  const messagesByPeerRef = useRef<Record<string, CloudMessage[]>>({});
  const canonicalSessionStateRef = useRef<CanonicalSessionState | null>(canonicalSessionState ?? null);
  const cloudGroupOfflineTimersRef = useRef<Map<string, number>>(new Map());
  const [readInboundMessageIdsByPeer, setReadInboundMessageIdsByPeer] = useState<Record<string, Set<string>>>({});
  const [localAgentTurnsByRequestId, setLocalAgentTurnsByRequestId] = useState<Record<string, DesktopChatTurnSnapshot>>({});
  const [cloudBridgeOverride, setCloudBridgeOverrideState] = useState<DesktopBridgeState | null>(null);
  const cloudBridgeStateRef = useRef<DesktopBridgeState | null>(null);
  const readReceiptRequestRef = useRef<string | null>(null);
  const processedCloudAgentMentionIdsRef = useRef<Set<string>>(new Set());
  const processedCloudGroupControlIdsRef = useRef<Set<string>>(new Set());
  const cloudAgentTurnIdsByRequestIdRef = useRef<Map<string, string>>(new Map());
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    messagesByPeerRef.current = messagesByPeer;
  }, [messagesByPeer]);

  useEffect(() => {
    canonicalSessionStateRef.current = canonicalSessionState ?? null;
  }, [canonicalSessionState]);

  useEffect(() => () => {
    for (const timerId of cloudGroupOfflineTimersRef.current.values()) window.clearTimeout(timerId);
    cloudGroupOfflineTimersRef.current.clear();
  }, []);

  const acceptedContactPeerIds = useMemo(
    () => contacts.contacts
      .map((contact) => contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, ''))
      .filter((value): value is string => Boolean(value)),
    [contacts.contacts],
  );
  const groupParticipantContacts = useMemo(
    () => account
      ? cloudGroupParticipantContacts({
        account,
        canonicalSessionState,
        existingPeerIds: acceptedContactPeerIds,
      })
      : [],
    [account, acceptedContactPeerIds, canonicalSessionState],
  );
  const cloudBridgeContacts = contacts.contacts;
  const groupParticipantPeerIds = useMemo(
    () => groupParticipantContacts
      .map((contact) => contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, ''))
      .filter((value): value is string => Boolean(value)),
    [groupParticipantContacts],
  );
  const cloudLookupContacts = useMemo(
    () => [...contacts.contacts, ...groupParticipantContacts],
    [contacts.contacts, groupParticipantContacts],
  );
  const contactPeerIds = useMemo(
    () => contacts.contacts
      .map((contact) => contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, ''))
      .filter((value): value is string => Boolean(value)),
    [contacts.contacts],
  );
  const bootstrapPeerIds = useMemo(() => {
    const messagePeerIds = [...new Set([...contactPeerIds, ...groupParticipantPeerIds])];
    return account
      ? cloudGroupPeerIdsFromContactsAndRequests({
        accountId: account.accountId,
        contactPeerIds: messagePeerIds,
        requests: contacts.requests,
      })
      : messagePeerIds;
  }, [account, contactPeerIds, groupParticipantPeerIds, contacts.requests]);
  const localHumanIdentityId = canonicalSessionState?.profile.humanIdentityId?.trim() || '';

  useEffect(() => {
    if (!account || !localHumanIdentityId || !setCanonicalSessionState) return;
    let cancelled = false;
    void (async () => {
      for (const request of cloudContactsToCanonicalIdentityRequests({
        account,
        contacts: contacts.contacts,
        localHumanIdentityId,
      })) {
        if (cancelled) return;
        const nextState = await upsertCanonicalIdentity(request);
        if (!cancelled) setCanonicalSessionState(nextState);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, contacts.contacts, localHumanIdentityId, setCanonicalSessionState]);

  const refreshCloudBridgeMessages = useCallback(async () => {
    const retainedPeerIds = Object.keys(messagesByPeerRef.current);
    const initialPeerIds = [...new Set([...bootstrapPeerIds, ...retainedPeerIds])];
    if (!account || initialPeerIds.length === 0) {
      setMessagesByPeer((current) => (Object.keys(current).length === 0 ? current : {}));
      return;
    }
    const session = await loadSession();
    if (!session?.token) return;

    const byPeer: Record<string, CloudMessage[]> = {};
    let peerIds = initialPeerIds;
    for (let pass = 0; pass < 3; pass += 1) {
      const missingPeerIds = peerIds.filter((peerId) => !(peerId in byPeer));
      if (missingPeerIds.length === 0) break;
      const entries = await Promise.all(missingPeerIds.map(async (peerId) => {
        try {
          return [peerId, await client.listMessages(session.token, peerId)] as const;
        } catch {
          return [peerId, messagesByPeerRef.current[peerId] ?? []] as const;
        }
      }));
      for (const [peerId, messages] of entries) byPeer[peerId] = messages;
      const expandedPeerIds = cloudGroupPeerIdsFromMessages({
        accountId: account.accountId,
        contactPeerIds: peerIds,
        messages: Object.values(byPeer).flat(),
      });
      if (expandedPeerIds.length === peerIds.length) break;
      peerIds = expandedPeerIds;
    }

    if (cancelledRef.current) return;
    setMessagesByPeer((current) => (cloudMessagesByPeerEqual(current, byPeer) ? current : byPeer));
  }, [account, bootstrapPeerIds, client]);

  useEffect(() => {
    if (!account) {
      setMessagesByPeer({});
      setReadInboundMessageIdsByPeer({});
      setLocalAgentTurnsByRequestId({});
      setCloudBridgeOverrideState(null);
      return;
    }
    void refreshCloudBridgeMessages();
    const interval = window.setInterval(() => void refreshCloudBridgeMessages(), CLOUD_MESSAGES_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [account, refreshCloudBridgeMessages]);

  useEffect(() => {
    if (!account || !canonicalSessionState || !setCanonicalSessionState) {
      for (const timerId of cloudGroupOfflineTimersRef.current.values()) window.clearTimeout(timerId);
      cloudGroupOfflineTimersRef.current.clear();
      return;
    }

    const candidates = cloudAgentMentionCandidates(canonicalSessionState, account.accountId);
    const activeKeys = new Set<string>();

    for (const candidate of candidates) {
      const noticeId = `msg:cloud-agent-offline:${candidate.requestMessage.id}:${candidate.targetAccountId}`;
      const key = `${candidate.requestMessage.id}\u001f${candidate.targetAccountId}`;
      const existingNotice = canonicalSessionState.messages.find((message) => message.id === noticeId);
      const hasRequestingNotice = existingNotice?.sourceTransport === 'cloud-group-agent-offline' && existingNotice.status !== 'failed';
      if (Date.now() - candidate.requestMessage.createdAtMs > CLOUD_AGENT_MENTION_WINDOW_MS && !hasRequestingNotice) continue;
      activeKeys.add(key);
      const responseState = cloudGroupAgentMentionResponseState({
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        messages: canonicalSessionState.messages,
      });
      const hasOfflineNotice = existingNotice?.status === 'failed';
      if (responseState || hasOfflineNotice) {
        const timerId = cloudGroupOfflineTimersRef.current.get(key);
        if (timerId !== undefined) window.clearTimeout(timerId);
        cloudGroupOfflineTimersRef.current.delete(key);
        setCanonicalSessionState((current) => (
          responseState === 'processing'
            ? setCloudGroupRequestPlaceholderProcessing(current, candidate, noticeId)
            : removeCloudGroupOfflinePlaceholder(current, noticeId)
        ));
        continue;
      }
      if (cloudGroupOfflineTimersRef.current.has(key)) continue;

      setCanonicalSessionState((current) => appendCloudGroupRequestingPlaceholder(current, candidate, noticeId));
      void upsertCanonicalMessage(cloudGroupAgentRequestingNoticeRequest({
        sessionId: candidate.requestMessage.sessionId,
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        targetAgentDisplayName: candidate.targetAgentDisplayName,
        createdAtMs: Date.now(),
      }))
        .then((nextState) => {
          canonicalSessionStateRef.current = nextState;
          setCanonicalSessionState(nextState);
        })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.warn('[cloud-group-agent-requesting] failed to persist requesting notice', error);
        });
      const delayMs = Math.max(0, candidate.requestMessage.createdAtMs + CLOUD_GROUP_AGENT_OFFLINE_TIMEOUT_MS - Date.now());
      const timerId = window.setTimeout(() => {
        cloudGroupOfflineTimersRef.current.delete(key);
        void (async () => {
          const current = canonicalSessionStateRef.current;
          if (!current) return;
          const existingTimerNotice = current.messages.find((message) => message.id === noticeId);
          if (existingTimerNotice?.status === 'failed') return;
          if (cloudGroupAgentMentionHasResponse({
            requestMessageId: candidate.requestMessage.id,
            targetAccountId: candidate.targetAccountId,
            messages: current.messages,
          })) return;

          const humanIdentity = current.identities.find((identity) => (
            identity.kind === 'human'
            && (identity.humanId === candidate.targetAccountId || identity.bridgeNodeId === candidate.targetAccountId)
          ));
          const agentIdentityId = `agent:cloud:${candidate.targetAccountId}`;
          if (!current.identities.some((identity) => identity.id === agentIdentityId)) {
            const nextState = await upsertCanonicalIdentity({
              id: agentIdentityId,
              kind: 'agent',
              displayName: candidate.targetAgentDisplayName,
              ownerIdentityId: humanIdentity?.id ?? null,
              source: 'bridge',
              sourceHostId: CLOUD_HOST_SENTINEL,
              bridgeNodeId: `cloud-agent:${candidate.targetAccountId}`,
              humanId: candidate.targetAccountId,
              agentId: `cloud-agent:${candidate.targetAccountId}`,
              avatarKey: `cloud-agent:${candidate.targetAccountId}`,
              profileImageUrl: null,
              metadata: { accountId: candidate.targetAccountId, cloudGroupAgent: true },
            });
            canonicalSessionStateRef.current = nextState;
            setCanonicalSessionState(nextState);
          }

          const createdAtMs = Date.now();
          const notice = cloudGroupAgentOfflineNoticeRequest({
            sessionId: candidate.requestMessage.sessionId,
            requestMessageId: candidate.requestMessage.id,
            targetAccountId: candidate.targetAccountId,
            targetHumanDisplayName: candidate.targetHumanDisplayName,
            targetAgentDisplayName: candidate.targetAgentDisplayName,
            createdAtMs,
          });
          const afterAppend = await upsertCanonicalMessage(notice);
          const failedState = markOptimisticCanonicalMessageFailed(
            afterAppend,
            candidate.requestMessage.sessionId,
            candidate.requestMessage.id,
            notice.contentText,
          );
          canonicalSessionStateRef.current = failedState;
          setCanonicalSessionState(failedState);
        })().catch((error) => {
          // eslint-disable-next-line no-console
          console.warn('[cloud-group-agent-offline] failed to append offline notice', error);
        });
      }, delayMs);
      cloudGroupOfflineTimersRef.current.set(key, timerId);
    }

    for (const [key, timerId] of cloudGroupOfflineTimersRef.current.entries()) {
      if (activeKeys.has(key)) continue;
      window.clearTimeout(timerId);
      cloudGroupOfflineTimersRef.current.delete(key);
      const [requestMessageId, targetAccountId] = key.split('\u001f');
      if (requestMessageId && targetAccountId) {
        setCanonicalSessionState((current) => removeCloudGroupOfflinePlaceholder(
          current,
          `msg:cloud-agent-offline:${requestMessageId}:${targetAccountId}`,
        ));
      }
    }
  }, [account, canonicalSessionState, setCanonicalSessionState]);

  const mergeMessage = useCallback((message: CloudMessage) => {
    const peerId = message.fromAccountId === account?.accountId ? message.toAccountId : message.fromAccountId;
    if (!peerId) return;
    setMessagesByPeer((current) => {
      const previous = current[peerId] ?? [];
      if (previous.some((candidate) => candidate.messageId === message.messageId)) return current;
      const next = [...previous, message].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return { ...current, [peerId]: next };
    });
  }, [account?.accountId]);

  const applyCloudGroupControl = useCallback(async (cloudMessage: CloudMessage, envelope: CloudGroupControlEnvelope) => {
    if (!account || !canonicalSessionState || !setCanonicalSessionState) return;
    const localHumanIdentityId = canonicalSessionState.profile.humanIdentityId?.trim();
    if (!localHumanIdentityId) return;

    const participantByAccount = new Map<string, CloudGroupParticipant>();
    for (const participant of [envelope.actor, ...envelope.participants, cloudGroupSelfParticipant(account, 'self')]) {
      const normalized = participant.accountId.trim() ? participant : null;
      if (!normalized || participantByAccount.has(normalized.accountId)) continue;
      participantByAccount.set(normalized.accountId, normalized);
    }

    const identityIdByAccount = new Map<string, string>();
    let nextState: CanonicalSessionState | null = canonicalSessionState;
    for (const participant of participantByAccount.values()) {
      const request = cloudGroupIdentityRequest(participant, account, localHumanIdentityId);
      identityIdByAccount.set(participant.accountId, request.id ?? '');
      nextState = await upsertCanonicalIdentity(request);
      setCanonicalSessionState(nextState);
    }

    const createdByIdentityId = identityIdByAccount.get(envelope.createdByAccountId)
      ?? identityIdByAccount.get(envelope.actor.accountId)
      ?? localHumanIdentityId;
    const participantIdentityIds = [...identityIdByAccount.entries()]
      .filter(([accountId, identityId]) => accountId !== envelope.createdByAccountId && identityId !== createdByIdentityId)
      .map(([, identityId]) => identityId);
    const sessionTitleUpdateTitle = cloudSessionTitleUpdateTitle(envelope);
    const explicitGroupTitle = shouldApplyCloudGroupTitleUpdate(envelope) ? cloudGroupNonGenericTitle(envelope.groupTitle) : null;
    const isSelfAuthoredControl = envelope.actor.accountId === account.accountId || envelope.createdByAccountId === account.accountId;
    const groupTitle = explicitGroupTitle || 'Cloud group';
    const groupSpaceId = envelope.groupSpaceId?.trim() || envelope.groupId;
    const participantNames = [...participantByAccount.values()].map((participant) => participant.displayName);
    const groupMetadata = {
      schemaVersion: 1,
      kind: 'chat-group',
      ...(explicitGroupTitle ? { customName: explicitGroupTitle } : {}),
      groupId: groupSpaceId,
      groupSpaceId,
      adminIdentityIds: [createdByIdentityId],
      initialContactIds: [...participantByAccount.keys()].map((accountId) => `cloud:${accountId}`),
      initialParticipantNames: participantNames,
      memberApprovalPolicy: 'under-50-open',
      createdFrom: 'cloud-group-sync',
    };
    const parsedControlCreatedAtMs = Date.parse(cloudMessage.createdAt);
    const controlCreatedAtMs = Number.isFinite(parsedControlCreatedAtMs) ? parsedControlCreatedAtMs : Date.now();
    nextState = await openOrCreateCanonicalSession({
      id: envelope.groupId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId,
      primaryIdentityId: null,
      relationshipIdentityId: null,
      participantIdentityIds,
      metadata: groupMetadata,
    });
    setCanonicalSessionState(nextState);

    if (sessionTitleUpdateTitle) {
      const actorIdentityId = identityIdByAccount.get(envelope.actor.accountId) ?? createdByIdentityId;
      nextState = await renameCanonicalSession({
        sessionId: envelope.groupId,
        title: sessionTitleUpdateTitle,
        requestedByIdentityId: actorIdentityId,
      });
      setCanonicalSessionState(nextState);
      if (!isSelfAuthoredControl) {
        const noticeRequest = cloudSessionTitleUpdateNoticeRequest({
          envelope,
          actorIdentityId,
          createdAtMs: controlCreatedAtMs,
          cloudMessageId: cloudMessage.messageId,
        });
        if (noticeRequest && !nextState.messages.some((message) => message.id === noticeRequest.id)) {
          nextState = await appendCanonicalMessage(noticeRequest);
          setCanonicalSessionState(nextState);
        }
      }
    }

    if (shouldApplyCloudGroupTitleUpdate(envelope)) {
      nextState = await updateCanonicalSessionMetadata({
        sessionId: envelope.groupId,
        requestedByIdentityId: identityIdByAccount.get(envelope.actor.accountId) ?? createdByIdentityId,
        metadata: groupMetadata,
      });
      setCanonicalSessionState(nextState);
      if (!isSelfAuthoredControl) {
        const noticeRequest = cloudGroupTitleUpdateNoticeRequest({
          envelope,
          actorIdentityId: identityIdByAccount.get(envelope.actor.accountId) ?? createdByIdentityId,
          createdAtMs: controlCreatedAtMs,
          cloudMessageId: cloudMessage.messageId,
        });
        if (noticeRequest && !nextState.messages.some((message) => message.id === noticeRequest.id)) {
          nextState = await appendCanonicalMessage(noticeRequest);
          setCanonicalSessionState(nextState);
        }
      }
    }

    if (envelope.kind !== 'group-message' || !envelope.message) return;
    const senderHumanIdentityId = identityIdByAccount.get(envelope.message.senderAccountId);
    if (!senderHumanIdentityId) return;
    const messageAlreadyExists = [canonicalSessionState, nextState]
      .filter((state): state is CanonicalSessionState => Boolean(state))
      .some((state) => state.messages.some((candidate) => candidate.id === envelope.message?.id));

    const senderIsAgent = envelope.message.senderKind === 'agent';
    const senderIdentityId = senderIsAgent ? `agent:cloud:${envelope.message.senderAccountId}` : senderHumanIdentityId;
    const messageReplyToId = envelope.message.replyToMessageId?.trim()
      || envelope.message.requestId?.trim()
      || null;
    const agentDeliveryState = senderIsAgent
      ? (envelope.message.deliveryState?.trim() || (isCloudAgentProcessingPlaceholderText(envelope.message.text) ? 'processing' : 'complete'))
      : null;
    if (senderIsAgent) {
      const owner = participantByAccount.get(envelope.message.senderAccountId);
      nextState = await upsertCanonicalIdentity({
        id: senderIdentityId,
        kind: 'agent',
        displayName: envelope.message.senderDisplayName?.trim() || `${owner?.displayName || 'Cloud user'}'s Kordi`,
        ownerIdentityId: senderHumanIdentityId,
        source: 'bridge',
        sourceHostId: 'cloud',
        bridgeNodeId: `cloud-agent:${envelope.message.senderAccountId}`,
        humanId: envelope.message.senderAccountId,
        agentId: `cloud-agent:${envelope.message.senderAccountId}`,
        avatarKey: `cloud-agent:${envelope.message.senderAccountId}`,
        profileImageUrl: null,
        metadata: { accountId: envelope.message.senderAccountId, cloudGroupAgent: true },
      });
      setCanonicalSessionState(nextState);
    }
    if (!messageAlreadyExists) {
      const stableAgentNoticeId = senderIsAgent && messageReplyToId
        ? `msg:cloud-agent-offline:${messageReplyToId}:${envelope.message.senderAccountId}`
        : null;
      const shouldUpdateStableAgentSlot = Boolean(stableAgentNoticeId && [canonicalSessionState, nextState].some((state) => (
        state?.messages.some((message) => message.id === stableAgentNoticeId)
      )));
      const messageRequest = {
        id: shouldUpdateStableAgentSlot ? stableAgentNoticeId : envelope.message.id,
        sessionId: envelope.groupId,
        senderIdentityId,
        senderRole: senderIsAgent ? 'external-agent' : (envelope.message.senderAccountId === account.accountId ? 'user' : 'person'),
        messageKind: senderIsAgent ? 'agent-turn' : 'text',
        contentText: envelope.message.text,
        content: senderIsAgent ? {
          sender: envelope.message.senderDisplayName?.trim() || 'Kordi',
          timestampMs: envelope.message.createdAtMs,
          deliveryState: agentDeliveryState,
          bridgeConversationId: cloudGroupAgentConversationId(envelope.groupId),
          requestId: messageReplyToId,
          replyToMessageId: messageReplyToId,
        } : undefined,
        createdAtMs: envelope.message.createdAtMs,
        parentMessageId: senderIsAgent ? messageReplyToId : null,
        status: senderIsAgent && agentDeliveryState === 'processing'
          ? 'processing'
          : envelope.message.senderAccountId === account.accountId ? 'sent' : 'received',
        sourceTransport: senderIsAgent ? 'cloud-group-agent' : 'cloud-group',
        sourceEventId: `${senderIsAgent ? 'cloud-group-agent' : 'cloud-group'}:${cloudMessage.messageId}`,
      };
      nextState = shouldUpdateStableAgentSlot
        ? await upsertCanonicalMessage(messageRequest)
        : await appendCanonicalMessage(messageRequest);
      setCanonicalSessionState(nextState);
      if (shouldCountCloudGroupMessageUnread({ activeConversationId, groupId: envelope.groupId, groupSpaceId })) {
        incrementLocalSessionUnread?.(envelope.groupId, 1);
      }
    }

    const groupMessageIsOwn = envelope.message.senderAccountId === account.accountId;
    const groupMessageMentionsLocalAgent = cloudMessageMentionsLocalAgent(
      envelope.message.text,
      account,
      { allowFirstPerson: groupMessageIsOwn },
    );
    if (
      !senderIsAgent
      && groupMessageMentionsLocalAgent
      && isRecentCloudAgentMention(cloudMessage.createdAt)
      && !processedCloudAgentMentionIdsRef.current.has(envelope.message.id)
    ) {
      const allCloudMessages = Object.values(messagesByPeer).flat();
      if (cloudGroupLocalAgentRequestAlreadyHandled({
        localAccountId: account.accountId,
        requestMessageId: envelope.message.id,
        messages: allCloudMessages,
      })) {
        processedCloudAgentMentionIdsRef.current.add(envelope.message.id);
        return;
      }
      processedCloudAgentMentionIdsRef.current.add(envelope.message.id);
      void (async () => {
        const session = await loadSession();
        if (!session?.token) throw new Error('Not signed in.');
        const agentIdentityId = `agent:cloud:${account.accountId}`;
        const agentDisplayName = `${account.displayName || account.primaryEmail || 'Cloud user'}'s Kordi`;
        await upsertCanonicalIdentity({
          id: agentIdentityId,
          kind: 'agent',
          displayName: agentDisplayName,
          ownerIdentityId: localHumanIdentityId,
          source: 'local',
          sourceHostId: 'cloud',
          bridgeNodeId: `cloud-agent:${account.accountId}`,
          humanId: account.accountId,
          agentId: `cloud-agent:${account.accountId}`,
          avatarKey: `cloud-agent:${account.accountId}`,
          profileImageUrl: null,
          metadata: { accountId: account.accountId, cloudGroupAgent: true },
        });
        const processingMessageId = `msg:cloud-agent-processing:${envelope.message!.id}:${account.accountId}`;
        const processingState = await appendCanonicalMessage({
          id: processingMessageId,
          sessionId: envelope.groupId,
          senderIdentityId: agentIdentityId,
          senderRole: 'owned-agent',
          messageKind: 'agent-turn',
          contentText: 'processing...',
          content: {
            sender: 'My Kordi',
            timestampMs: Date.now(),
            deliveryState: 'processing',
            bridgeConversationId: cloudGroupAgentConversationId(envelope.groupId),
            requestId: envelope.message!.id,
            replyToMessageId: envelope.message!.id,
          },
          createdAtMs: Date.now(),
          parentMessageId: envelope.message!.id,
          status: 'processing',
          sourceTransport: 'cloud-group-agent',
          sourceEventId: `cloud-group-agent:${processingMessageId}`,
        });
        setCanonicalSessionState(processingState);
        const targetAccountIds = cloudGroupAgentResponseTargetAccountIds({
          localAccountId: account.accountId,
          envelope,
          requestCloudMessage: cloudMessage,
        });
        const processingBody = encodeCloudGroupControl({
          kind: 'group-message',
          groupId: envelope.groupId,
          groupSpaceId,
          groupTitle: null,
          createdByAccountId: envelope.createdByAccountId,
          actor: cloudGroupSelfParticipant(account, 'person'),
          participants: [...participantByAccount.values()],
          message: {
            id: processingMessageId,
            senderAccountId: account.accountId,
            text: 'processing...',
            createdAtMs: Date.now(),
            senderKind: 'agent',
            senderDisplayName: agentDisplayName,
            deliveryState: 'processing',
            replyToMessageId: envelope.message!.id,
            requestId: envelope.message!.id,
          },
        });
        const processingSent = await Promise.allSettled(
          targetAccountIds.map((targetAccountId) => client.sendMessage(session.token, targetAccountId, processingBody)),
        );
        processingSent.forEach((result) => {
          if (result.status === 'fulfilled') mergeMessage(result.value);
        });
        const prompt = promptTextForCloudAgentMention(envelope.message!.text);
        const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
          setLocalAgentTurnsByRequestId((current) => ({ ...current, [envelope.message!.id]: turn }));
        };
        const runtimeSessionId = `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${account.accountId}:${envelope.groupId}`;
        const startedTurn = await startDesktopChatMessage(
          runtimeSessionId,
          prompt,
          [],
          cloudAgentRuntimeRouteForSession(cloudAgentRuntimeRoutesBySessionId, runtimeSessionId),
        );
        rememberLocalTurn(startedTurn);
        cloudAgentTurnIdsByRequestIdRef.current.set(envelope.message!.id, startedTurn.id);
        const finalTurn = startedTurn.completed ? startedTurn : await waitForCloudAgentTurn(startedTurn.id, rememberLocalTurn);
        rememberLocalTurn(finalTurn);
        cloudAgentTurnIdsByRequestIdRef.current.delete(envelope.message!.id);
        if (finalTurn.status === 'cancelled') return;
        const responseText = finalTurn.succeeded && finalTurn.assistantText.trim()
          ? finalTurn.assistantText.trim()
          : `Failed: ${finalTurn.error || finalTurn.message || 'Cloud agent returned no text response'}`;
        const responseMessageId = `msg:cloud-agent:${finalTurn.id}`;
        const responseState = await appendCanonicalMessage({
          id: responseMessageId,
          sessionId: envelope.groupId,
          senderIdentityId: agentIdentityId,
          senderRole: 'owned-agent',
          messageKind: 'agent-turn',
          contentText: responseText,
          content: {
            sender: 'My Kordi',
            timestampMs: Date.now(),
            deliveryState: 'complete',
            bridgeConversationId: cloudGroupAgentConversationId(envelope.groupId),
            requestId: envelope.message!.id,
            replyToMessageId: envelope.message!.id,
          },
          createdAtMs: Date.now(),
          parentMessageId: envelope.message!.id,
          status: 'complete',
          sourceTransport: 'cloud-group-agent',
          sourceEventId: `cloud-group-agent:${responseMessageId}`,
        });
        setCanonicalSessionState(responseState);
        const responseBody = encodeCloudGroupControl({
          kind: 'group-message',
          groupId: envelope.groupId,
          groupSpaceId,
          groupTitle: null,
          createdByAccountId: envelope.createdByAccountId,
          actor: cloudGroupSelfParticipant(account, 'person'),
          participants: [...participantByAccount.values()],
          message: {
            id: responseMessageId,
            senderAccountId: account.accountId,
            text: responseText,
            createdAtMs: Date.now(),
            senderKind: 'agent',
            senderDisplayName: agentDisplayName,
            deliveryState: 'complete',
            replyToMessageId: envelope.message!.id,
            requestId: envelope.message!.id,
          },
        });
        const sent = await Promise.allSettled(
          targetAccountIds.map((targetAccountId) => client.sendMessage(session.token, targetAccountId, responseBody)),
        );
        sent.forEach((result) => {
          if (result.status === 'fulfilled') mergeMessage(result.value);
        });
        void refreshCloudBridgeMessages();
      })().catch((error) => {
        cloudAgentTurnIdsByRequestIdRef.current.delete(envelope.message!.id);
        processedCloudAgentMentionIdsRef.current.delete(envelope.message!.id);
        // eslint-disable-next-line no-console
        console.warn('[cloud-group-agent-mention] local agent response failed', error);
      });
    }
  }, [
    account,
    activeConversationId,
    canonicalSessionState,
    client,
    cloudAgentRuntimeRoutesBySessionId,
    incrementLocalSessionUnread,
    mergeMessage,
    messagesByPeer,
    refreshCloudBridgeMessages,
    setCanonicalSessionState,
  ]);

  useEffect(() => {
    if (!account) return;
    let ws: WebSocket | null = null;
    let cancelled = false;
    const open = async () => {
      const session = await loadSession();
      if (!session?.token || cancelled) return;
      ws = new WebSocket(cloudWebSocketUrl(session.token));
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
          const subject: string | undefined = frame?.subject;
          if (subject?.startsWith('kordi.events.message.read.')) {
            void refreshCloudBridgeMessages();
            return;
          }
          if (!subject?.startsWith('kordi.events.message.arrived.')) return;
          const payload = frame?.payload;
          if (!payload || typeof payload !== 'object') return;
          const from = payload.from_account_id as string | undefined;
          const to = payload.to_account_id as string | undefined;
          if (!from || !to) return;
          mergeMessage({
            messageId: payload.message_id,
            fromAccountId: from,
            toAccountId: to,
            body: payload.body,
            createdAt: payload.created_at,
            deliveredAt: payload.delivered_at ?? payload.created_at ?? null,
            readAt: payload.read_at ?? null,
            direction: to === account.accountId ? 'incoming' : 'outgoing',
          });
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[cloud-bridge-ws] frame parse failed', error);
        }
      };
    };
    void open();
    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [account, mergeMessage, refreshCloudBridgeMessages]);

  useEffect(() => {
    if (!account || !setCanonicalSessionState) return;
    const cloudMessages = Object.values(messagesByPeer).flat();
    if (cloudMessages.length === 0) return;

    setCanonicalSessionState((current) => {
      if (!current) return current;
      let changed = false;
      const messages = current.messages.map((message) => {
        if (message.senderRole !== 'user') return message;
        const deliveryState = cloudGroupDeliveryStateFromMessages({
          accountId: account.accountId,
          messageId: message.id,
          messages: cloudMessages,
        });
        if (!deliveryState) return message;
        const content = objectContent(message.content);
        if (message.status === 'sent' && content.deliveryState === deliveryState) return message;
        changed = true;
        return {
          ...message,
          status: 'sent',
          content: {
            ...content,
            deliveryState,
          },
        };
      });
      return changed ? { ...current, messages } : current;
    });
  }, [account, messagesByPeer, setCanonicalSessionState]);

  useEffect(() => {
    if (!account || !setCanonicalSessionState) return;
    const unreadBySessionId = cloudGroupUnreadCountsBySessionId({
      accountId: account.accountId,
      activeConversationId,
      messages: Object.values(messagesByPeer).flat(),
    });
    setCanonicalSessionState((current) => {
      if (!current) return current;
      let changed = false;
      const sessions = current.sessions.map((session) => {
        const metadata = objectContent(session.metadata);
        const existingUnread = typeof metadata.cloudUnreadCount === 'number' && Number.isFinite(metadata.cloudUnreadCount)
          ? Math.max(0, Math.floor(metadata.cloudUnreadCount))
          : 0;
        const nextUnread = unreadBySessionId[session.id] ?? 0;
        if (existingUnread === nextUnread) return session;
        changed = true;
        if (nextUnread > 0) {
          return {
            ...session,
            metadata: {
              ...metadata,
              cloudUnreadCount: nextUnread,
            },
          };
        }
        const restMetadata = { ...metadata };
        delete restMetadata.cloudUnreadCount;
        return {
          ...session,
          metadata: restMetadata,
        };
      });
      return changed ? { ...current, sessions } : current;
    });
  }, [account, activeConversationId, canonicalSessionState?.sessions, messagesByPeer, setCanonicalSessionState]);

  useEffect(() => {
    if (!account || !canonicalSessionState?.profile.humanIdentityId || !setCanonicalSessionState) return;
    const replayMessages = cloudGroupControlMessagesForAccount({
      accountId: account.accountId,
      messages: Object.values(messagesByPeer).flat(),
    });
    for (const message of replayMessages) {
      const envelope = parseCloudGroupControl(message.body);
      if (!envelope) continue;
      const replayKey = cloudGroupControlReplayKey(message) ?? message.messageId;
      if (processedCloudGroupControlIdsRef.current.has(replayKey)) continue;
      processedCloudGroupControlIdsRef.current.add(replayKey);
      void applyCloudGroupControl(message, envelope).catch((error) => {
        processedCloudGroupControlIdsRef.current.delete(replayKey);
        // eslint-disable-next-line no-console
        console.warn('[cloud-group] sync failed', error);
      });
    }
  }, [account, applyCloudGroupControl, canonicalSessionState?.profile.humanIdentityId, messagesByPeer, setCanonicalSessionState]);

  useEffect(() => {
    if (!account) return;
    for (const messages of Object.values(messagesByPeer)) {
      for (const message of messages) {
        if (message.fromAccountId !== account.accountId && message.toAccountId !== account.accountId) continue;
        const cancel = parseCloudAgentCancel(message.body);
        if (!cancel) continue;
        processedCloudAgentMentionIdsRef.current.add(cancel.requestId);
        const turnId = cloudAgentTurnIdsByRequestIdRef.current.get(cancel.requestId);
        if (!turnId) continue;
        void cancelDesktopChatTurn(turnId)
          .catch((error) => {
            // eslint-disable-next-line no-console
            console.warn('[cloud-agent-mention] local agent cancel failed', error);
          })
          .finally(() => {
            cloudAgentTurnIdsByRequestIdRef.current.delete(cancel.requestId);
          });
      }
    }

    for (const [peerId, messages] of Object.entries(messagesByPeer)) {
      for (const message of messages) {
        if (message.fromAccountId !== account.accountId && message.toAccountId !== account.accountId) continue;
        if (parseCloudGroupControl(message.body) || parseCloudAgentResponse(message.body) || parseCloudAgentCancel(message.body)) continue;
        if (!cloudMessageMentionsLocalAgent(message.body, account, {
          allowFirstPerson: message.fromAccountId === account.accountId,
        })) continue;
        if (!isRecentCloudAgentMention(message.createdAt)) continue;
        if (processedCloudAgentMentionIdsRef.current.has(message.messageId)) continue;
        const alreadyAnswered = messages.some((candidate) => (
          candidate.fromAccountId === account.accountId
          && parseCloudAgentResponse(candidate.body)?.requestId === message.messageId
        ));
        if (alreadyAnswered) {
          processedCloudAgentMentionIdsRef.current.add(message.messageId);
          continue;
        }

        processedCloudAgentMentionIdsRef.current.add(message.messageId);
        void (async () => {
          const session = await loadSession();
          if (!session?.token) throw new Error('Not signed in.');
          const contact = cloudLookupContacts.find((candidate) => (
            candidate.bridgePeerNodeId || candidate.id.replace(/^cloud:/, '')
          ) === peerId);
          const peerHumanName = contact?.name?.trim() || contact?.owner?.trim() || peerId;
          const prompt = buildCloudAgentPromptWithSharedContext({
            messages,
            requestMessage: message,
            localAccountId: account.accountId,
            localHumanName: account.displayName || account.primaryEmail || 'Me',
            peerHumanName,
            localAgentName: 'My Kordi',
            peerAgentName: `${peerHumanName}'s Kordi`,
          });
          const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
            setLocalAgentTurnsByRequestId((current) => ({ ...current, [message.messageId]: turn }));
          };
          const runtimeSessionId = `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${account.accountId}:${peerId}`;
          const startedTurn = await startDesktopChatMessage(
            runtimeSessionId,
            prompt,
            [],
            cloudAgentRuntimeRouteForSession(cloudAgentRuntimeRoutesBySessionId, runtimeSessionId),
          );
          rememberLocalTurn(startedTurn);
          cloudAgentTurnIdsByRequestIdRef.current.set(message.messageId, startedTurn.id);
          const finalTurn = startedTurn.completed
            ? startedTurn
            : await waitForCloudAgentTurn(startedTurn.id, rememberLocalTurn);
          rememberLocalTurn(finalTurn);
          cloudAgentTurnIdsByRequestIdRef.current.delete(message.messageId);
          if (finalTurn.status === 'cancelled') {
            void refreshCloudBridgeMessages();
            return;
          }
          const responseText = finalTurn.succeeded && finalTurn.assistantText.trim()
            ? finalTurn.assistantText.trim()
            : `Failed: ${finalTurn.error || finalTurn.message || 'Cloud agent returned no text response'}`;
          const response = await client.sendMessage(
            session.token,
            peerId,
            encodeCloudAgentResponse({ requestId: message.messageId, text: responseText }),
          );
          mergeMessage(response);
          void refreshCloudBridgeMessages();
        })().catch((error) => {
          cloudAgentTurnIdsByRequestIdRef.current.delete(message.messageId);
          processedCloudAgentMentionIdsRef.current.delete(message.messageId);
          // eslint-disable-next-line no-console
          console.warn('[cloud-agent-mention] local agent response failed', error);
        });
      }
    }
  }, [account, client, cloudAgentRuntimeRoutesBySessionId, cloudLookupContacts, mergeMessage, messagesByPeer, refreshCloudBridgeMessages]);

  useEffect(() => {
    if (!account || !activeConversationId) return;
    const cloudGroupReadPeerIds = cloudGroupMessageReadPeerIds({
      accountId: account.accountId,
      activeConversationId,
      messages: Object.values(messagesByPeer).flat(),
    });
    if (cloudGroupReadPeerIds.length > 0) {
      void loadSession()
        .then((session) => {
          if (!session?.token) return null;
          return Promise.all(cloudGroupReadPeerIds.map((peerId) => client.markMessagesRead(session.token, peerId)));
        })
        .then((result) => {
          if (result === null) return;
          void refreshCloudBridgeMessages();
        })
        .catch(() => {});
    }

    const peerId = cloudPeerAccountIdFromConversationId(activeConversationId);
    if (!peerId) return;
    const inboundIds = (messagesByPeer[peerId] ?? [])
      .filter((message) => message.toAccountId === account.accountId)
      .map((message) => message.messageId)
      .filter(Boolean);
    if (inboundIds.length === 0) return;
    setReadInboundMessageIdsByPeer((current) => {
      const existing = current[peerId] ?? new Set<string>();
      const next = new Set(existing);
      for (const id of inboundIds) next.add(id);
      if (next.size === existing.size) return current;
      return { ...current, [peerId]: next };
    });
    const readSignature = `${peerId}:${inboundIds.slice().sort().join(',')}`;
    if (readReceiptRequestRef.current === readSignature) return;
    readReceiptRequestRef.current = readSignature;
    void loadSession()
      .then((session) => {
        if (!session?.token) return null;
        return client.markMessagesRead(session.token, peerId);
      })
      .then((result) => {
        if (result === null) return;
        void refreshCloudBridgeMessages();
      })
      .catch(() => {
        readReceiptRequestRef.current = null;
      });
  }, [account, activeConversationId, client, messagesByPeer, refreshCloudBridgeMessages]);

  useEffect(() => {
    if (!account) return;
    const refresh = () => void refreshCloudBridgeMessages();
    const refreshWhenVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [account, refreshCloudBridgeMessages]);

  const cloudBridgeState = useMemo(() => {
    if (!account) return null;
    const activeRuntimeSessionId = cloudAgentRuntimeSessionId(account.accountId, activeConversationId);
    const activeRuntimeRoute = cloudAgentRuntimeRouteForSession(cloudAgentRuntimeRoutesBySessionId, activeRuntimeSessionId);
    const generated = buildCloudDesktopBridgeState({
      account,
      contacts: cloudBridgeContacts,
      messagesByPeer,
      readInboundMessageIdsByPeer,
      activeConversationId,
      localAgentTurnsByRequestId,
      localAgentRuntimeRoute: activeRuntimeRoute,
    });
    return applyCloudAgentRuntimeRouteToState(
      mergeCloudBridgeState(generated, cloudBridgeOverride),
      activeRuntimeRoute,
    );
  }, [
    account,
    activeConversationId,
    cloudAgentRuntimeRoutesBySessionId,
    cloudBridgeOverride,
    cloudBridgeContacts,
    localAgentTurnsByRequestId,
    messagesByPeer,
    readInboundMessageIdsByPeer,
  ]);

  useEffect(() => {
    cloudBridgeStateRef.current = cloudBridgeState;
  }, [cloudBridgeState]);

  const setCloudBridgeState = useCallback<Dispatch<SetStateAction<DesktopBridgeState | null>>>((action) => {
    const current = cloudBridgeStateRef.current;
    const next = typeof action === 'function'
      ? (action as (value: DesktopBridgeState | null) => DesktopBridgeState | null)(current)
      : action;
    setCloudBridgeOverrideState(next);
  }, []);

  const mergedBridgeState = useMemo(
    () => mergeCloudBridgeState(baseBridgeState, cloudBridgeState),
    [baseBridgeState, cloudBridgeState],
  );

  const sendCloudBridgeMessage = useCallback(async (conversationId: string, text: string) => {
    const peerId = cloudPeerAccountIdFromConversationId(conversationId);
    const trimmed = text.trim();
    if (!peerId || !trimmed) throw new Error('Unable to resolve cloud conversation.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const message = await client.sendMessage(session.token, peerId, trimmed);
    mergeMessage(message);
    await refreshCloudBridgeMessages();
    setCloudBridgeOverrideState(null);
  }, [client, mergeMessage, refreshCloudBridgeMessages]);

  const sendCloudGroupControl = useCallback(async (input: SendCloudGroupControlInput) => {
    if (!account) throw new Error('Not signed in.');
    const relatedGroupControls = cloudGroupRelatedControlsForSend(Object.values(messagesByPeer)
      .flat()
      .flatMap((cloudMessage) => {
        const envelope = parseCloudGroupControl(cloudMessage.body);
        if (!envelope) return [];
        return [{
          envelope,
          createdAtMs: Date.parse(cloudMessage.createdAt) || 0,
        }];
      }), {
      groupId: input.groupId,
      groupSpaceId: input.groupSpaceId,
    }).sort((left, right) => left.createdAtMs - right.createdAtMs);
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const actor = input.actor ?? cloudGroupSelfParticipant(account, input.kind === 'group-message' ? 'person' : 'admin');
    const inputParticipants = input.participants?.length
      ? input.participants
      : cloudGroupParticipantsForBridgeSessionParticipants(account, input.bridgeParticipants ?? []);
    const participants = cloudGroupUniqueParticipants([
      ...inputParticipants,
      ...relatedGroupControls.flatMap((control) => control.envelope.participants),
    ]);
    const targetAccountIds = [...new Set([
      ...input.targetAccountIds.map((value) => value.trim()).filter(Boolean),
      ...participants.map((participant) => participant.accountId.trim()).filter(Boolean),
    ])].filter((accountId) => accountId !== account.accountId);
    if (targetAccountIds.length === 0) return;
    const groupTitle = cloudGroupTitleForOutgoingControl({
      kind: input.kind,
      groupTitle: input.groupTitle,
      relatedGroupTitles: relatedGroupControls.map((control) => control.envelope.groupTitle),
    });
    const message = input.message
      ? {
          ...input.message,
          senderAccountId: input.message.senderAccountId?.trim() || account.accountId,
        }
      : null;
    const envelope = encodeCloudGroupControl({
      kind: input.kind,
      groupId: input.groupId,
      groupSpaceId: input.groupSpaceId ?? null,
      groupTitle,
      createdByAccountId: input.createdByAccountId?.trim() || account.accountId,
      actor,
      participants,
      message,
    });
    const results = await Promise.allSettled(targetAccountIds.map((peerId) => client.sendMessage(session.token, peerId, envelope)));
    const sent = fulfilledCloudGroupSends(results);
    sent.forEach(mergeMessage);
    if (sent.length > 0) {
      await refreshCloudBridgeMessages();
      return;
    }
    const firstFailure = firstCloudGroupSendFailure(results);
    throw firstFailure instanceof Error ? firstFailure : new Error(String(firstFailure || 'Cloud group message failed.'));
  }, [account, client, mergeMessage, messagesByPeer, refreshCloudBridgeMessages]);

  const cancelCloudBridgeAgentRequest = useCallback(async (conversationId: string, requestId: string) => {
    const trimmedRequestId = requestId.trim();
    if (!trimmedRequestId) throw new Error('Unable to resolve cloud agent request.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');

    const groupId = cloudGroupIdFromAgentConversationId(conversationId);
    if (groupId) {
      processedCloudAgentMentionIdsRef.current.add(trimmedRequestId);
      const turnId = cloudAgentTurnIdsByRequestIdRef.current.get(trimmedRequestId);
      if (turnId) {
        await cancelDesktopChatTurn(turnId).finally(() => {
          cloudAgentTurnIdsByRequestIdRef.current.delete(trimmedRequestId);
        });
      }
      const processingMessage = canonicalSessionState?.messages.find((message) => {
        if (message.sessionId !== groupId || message.sourceTransport !== 'cloud-group-agent') return false;
        const content = objectContent(message.content);
        return typeof content.requestId === 'string' && content.requestId.trim() === trimmedRequestId;
      }) ?? null;
      if (processingMessage && setCanonicalSessionState) {
        const content = objectContent(processingMessage.content);
        const cancelledState = await appendCanonicalMessage({
          id: `msg:cloud-agent-cancelled:${trimmedRequestId}:${account?.accountId ?? 'local'}`,
          sessionId: groupId,
          senderIdentityId: processingMessage.senderIdentityId,
          senderRole: processingMessage.senderRole,
          messageKind: 'agent-turn',
          contentText: 'Stopped',
          content: {
            sender: typeof content.sender === 'string' ? content.sender : 'Kordi',
            timestampMs: Date.now(),
            deliveryState: 'cancelled',
            bridgeConversationId: conversationId,
            requestId: trimmedRequestId,
            replyToMessageId: trimmedRequestId,
          },
          createdAtMs: Date.now(),
          parentMessageId: trimmedRequestId,
          status: 'cancelled',
          sourceTransport: 'cloud-group-agent',
          sourceEventId: `cloud-group-agent-cancel:${trimmedRequestId}`,
        });
        setCanonicalSessionState(cancelledState);
      }
      const cancelBody = encodeCloudAgentCancel({ requestId: trimmedRequestId });
      const groupEnvelope = Object.values(messagesByPeer)
        .flat()
        .map((message) => parseCloudGroupControl(message.body))
        .find((envelope) => (
          envelope?.kind === 'group-message'
          && envelope.groupId === groupId
          && envelope.message?.id === trimmedRequestId
        ));
      const targetAccountIds = [...new Set((groupEnvelope?.participants ?? [])
        .map((participant) => participant.accountId.trim())
        .filter((accountId) => accountId && accountId !== account?.accountId))];
      const sent = await Promise.allSettled(
        targetAccountIds.map((targetAccountId) => client.sendMessage(session.token, targetAccountId, cancelBody)),
      );
      sent.forEach((result) => {
        if (result.status === 'fulfilled') mergeMessage(result.value);
      });
      await refreshCloudBridgeMessages();
      setCloudBridgeOverrideState(null);
      return;
    }

    const peerId = cloudPeerAccountIdFromConversationId(conversationId);
    if (!peerId) throw new Error('Unable to resolve cloud agent request.');
    const message = await client.sendMessage(session.token, peerId, encodeCloudAgentCancel({ requestId: trimmedRequestId }));
    mergeMessage(message);
    await refreshCloudBridgeMessages();
    setCloudBridgeOverrideState(null);
  }, [account?.accountId, canonicalSessionState?.messages, client, mergeMessage, messagesByPeer, refreshCloudBridgeMessages, setCanonicalSessionState]);

  return {
    cloudBridgeState,
    setCloudBridgeState,
    mergedBridgeState,
    sendCloudBridgeMessage,
    sendCloudGroupControl,
    cancelCloudBridgeAgentRequest,
    refreshCloudBridgeMessages,
  };
}

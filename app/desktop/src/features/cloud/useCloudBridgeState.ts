import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  appendCanonicalMessage,
  cancelDesktopChatTurn,
  fetchDesktopChatTurnState,
  openOrCreateCanonicalSession,
  startDesktopChatMessage,
  updateCanonicalSessionMetadata,
  upsertCanonicalIdentity,
} from '@/lib/desktop';
import type { CanonicalSessionState, DesktopBridgeSessionParticipant, DesktopBridgeState, DesktopChatTurnSnapshot } from '@/kordi-app/types';

import {
  CloudAuthClient,
  cloudWebSocketUrl,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudMessage,
} from './authClient';
import {
  buildCloudDesktopBridgeState,
  cloudPeerAccountIdFromConversationId,
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
  cloudGroupDeliveryStateFromMessages,
  cloudGroupIdentityRequest,
  cloudGroupMessageReadPeerIds,
  cloudGroupParticipantsForBridgeSessionParticipants,
  cloudGroupSelfParticipant,
  encodeCloudGroupControl,
  firstCloudGroupSendFailure,
  fulfilledCloudGroupSends,
  parseCloudGroupControl,
  shouldCountCloudGroupMessageUnread,
  type CloudGroupControlEnvelope,
  type CloudGroupParticipant,
} from './cloudGroupMessages';
import { loadSession } from './session';
import { useCloudContacts } from './useCloudContacts';

export const CLOUD_AGENT_MENTION_WINDOW_MS = 10 * 60_000;
export const CLOUD_AGENT_TURN_POLL_MS = 500;
export const CLOUD_AGENT_TURN_TIMEOUT_MS = 10 * 60_000;
export const CLOUD_MESSAGES_REFRESH_MS = 500;

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

export function useCloudBridgeState({
  account,
  baseBridgeState,
  activeConversationId,
  canonicalSessionState,
  setCanonicalSessionState,
  incrementLocalSessionUnread,
}: {
  account: CloudAccount | null;
  baseBridgeState: DesktopBridgeState | null;
  activeConversationId?: string | null;
  canonicalSessionState?: CanonicalSessionState | null;
  setCanonicalSessionState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  incrementLocalSessionUnread?: (sessionId: string, count?: number) => void;
}): UseCloudBridgeStateResult {
  const client = useMemo<CloudAuthClient>(() => defaultCloudAuthClient(), []);
  const contacts = useCloudContacts(account);
  const [messagesByPeer, setMessagesByPeer] = useState<Record<string, CloudMessage[]>>({});
  const messagesByPeerRef = useRef<Record<string, CloudMessage[]>>({});
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

  const contactPeerIds = useMemo(
    () => contacts.contacts
      .map((contact) => contact.bridgePeerNodeId || contact.id.replace(/^cloud:/, ''))
      .filter((value): value is string => Boolean(value)),
    [contacts.contacts],
  );

  const refreshCloudBridgeMessages = useCallback(async () => {
    if (!account || contactPeerIds.length === 0) {
      setMessagesByPeer({});
      return;
    }
    const session = await loadSession();
    if (!session?.token) return;
    const entries = await Promise.all(contactPeerIds.map(async (peerId) => {
      try {
        return [peerId, await client.listMessages(session.token, peerId)] as const;
      } catch {
        return [peerId, messagesByPeerRef.current[peerId] ?? []] as const;
      }
    }));
    if (cancelledRef.current) return;
    setMessagesByPeer(Object.fromEntries(entries));
  }, [account, client, contactPeerIds]);

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
    if (cloudMessage.fromAccountId === account.accountId) return;
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
    const groupTitle = envelope.groupTitle?.trim() || 'Cloud group';
    const groupSpaceId = envelope.groupSpaceId?.trim() || envelope.groupId;
    const participantNames = [...participantByAccount.values()].map((participant) => participant.displayName);
    nextState = await openOrCreateCanonicalSession({
      id: envelope.groupId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId,
      primaryIdentityId: null,
      relationshipIdentityId: null,
      participantIdentityIds,
      metadata: {
        schemaVersion: 1,
        kind: 'chat-group',
        customName: groupTitle,
        groupId: groupSpaceId,
        groupSpaceId,
        adminIdentityIds: [createdByIdentityId],
        initialContactIds: [...participantByAccount.keys()].map((accountId) => `cloud:${accountId}`),
        initialParticipantNames: participantNames,
        memberApprovalPolicy: 'under-50-open',
        createdFrom: 'cloud-group-sync',
      },
    });
    setCanonicalSessionState(nextState);

    if (envelope.kind === 'group-title-update' || envelope.kind === 'group-update' || envelope.kind === 'group-invite') {
      nextState = await updateCanonicalSessionMetadata({
        sessionId: envelope.groupId,
        requestedByIdentityId: identityIdByAccount.get(envelope.actor.accountId) ?? createdByIdentityId,
        metadata: {
          schemaVersion: 1,
          kind: 'chat-group',
          customName: groupTitle,
          groupId: groupSpaceId,
          groupSpaceId,
          adminIdentityIds: [createdByIdentityId],
          initialContactIds: [...participantByAccount.keys()].map((accountId) => `cloud:${accountId}`),
          initialParticipantNames: participantNames,
          memberApprovalPolicy: 'under-50-open',
          createdFrom: 'cloud-group-sync',
        },
      });
      setCanonicalSessionState(nextState);
    }

    if (envelope.kind !== 'group-message' || !envelope.message) return;
    const senderHumanIdentityId = identityIdByAccount.get(envelope.message.senderAccountId);
    if (!senderHumanIdentityId) return;
    const senderIsAgent = envelope.message.senderKind === 'agent';
    const senderIdentityId = senderIsAgent ? `agent:cloud:${envelope.message.senderAccountId}` : senderHumanIdentityId;
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
    nextState = await appendCanonicalMessage({
      id: envelope.message.id,
      sessionId: envelope.groupId,
      senderIdentityId,
      senderRole: senderIsAgent ? 'external-agent' : (envelope.message.senderAccountId === account.accountId ? 'user' : 'person'),
      messageKind: senderIsAgent ? 'agent-turn' : 'text',
      contentText: envelope.message.text,
      content: senderIsAgent ? {
        sender: envelope.message.senderDisplayName?.trim() || 'Kordi',
        timestampMs: envelope.message.createdAtMs,
        deliveryState: 'complete',
      } : undefined,
      createdAtMs: envelope.message.createdAtMs,
      status: envelope.message.senderAccountId === account.accountId ? 'sent' : 'received',
      sourceTransport: 'cloud-group',
      sourceEventId: `cloud-group:${cloudMessage.messageId}`,
    });
    setCanonicalSessionState(nextState);
    if (shouldCountCloudGroupMessageUnread({ activeConversationId, groupId: envelope.groupId, groupSpaceId })) {
      incrementLocalSessionUnread?.(envelope.groupId, 1);
    }

    if (
      !senderIsAgent
      && envelope.message.senderAccountId !== account.accountId
      && cloudMessageMentionsLocalAgent(envelope.message.text, account, { allowFirstPerson: false })
      && isRecentCloudAgentMention(cloudMessage.createdAt)
      && !processedCloudAgentMentionIdsRef.current.has(envelope.message.id)
    ) {
      processedCloudAgentMentionIdsRef.current.add(envelope.message.id);
      void (async () => {
        const session = await loadSession();
        if (!session?.token) throw new Error('Not signed in.');
        const prompt = promptTextForCloudAgentMention(envelope.message!.text);
        const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
          setLocalAgentTurnsByRequestId((current) => ({ ...current, [envelope.message!.id]: turn }));
        };
        const startedTurn = await startDesktopChatMessage(
          `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${account.accountId}:${envelope.groupId}`,
          prompt,
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
        const targetAccountIds = [...participantByAccount.keys()].filter((accountId) => accountId !== account.accountId);
        const responseMessageId = `msg:cloud-agent:${finalTurn.id}`;
        await upsertCanonicalIdentity({
          id: `agent:cloud:${account.accountId}`,
          kind: 'agent',
          displayName: `${account.displayName || account.primaryEmail || 'Cloud user'}'s Kordi`,
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
        const responseState = await appendCanonicalMessage({
          id: responseMessageId,
          sessionId: envelope.groupId,
          senderIdentityId: `agent:cloud:${account.accountId}`,
          senderRole: 'owned-agent',
          messageKind: 'agent-turn',
          contentText: responseText,
          content: {
            sender: 'My Kordi',
            timestampMs: Date.now(),
            deliveryState: 'complete',
          },
          createdAtMs: Date.now(),
          status: 'complete',
          sourceTransport: 'cloud-group-agent',
          sourceEventId: `cloud-group-agent:${responseMessageId}`,
        });
        setCanonicalSessionState(responseState);
        const responseBody = encodeCloudGroupControl({
          kind: 'group-message',
          groupId: envelope.groupId,
          groupSpaceId,
          groupTitle,
          createdByAccountId: envelope.createdByAccountId,
          actor: cloudGroupSelfParticipant(account, 'person'),
          participants: [...participantByAccount.values()],
          message: {
            id: responseMessageId,
            senderAccountId: account.accountId,
            text: responseText,
            createdAtMs: Date.now(),
            senderKind: 'agent',
            senderDisplayName: `${account.displayName || account.primaryEmail || 'Cloud user'}'s Kordi`,
          },
        });
        const sent = await Promise.allSettled(targetAccountIds.map((targetAccountId) => client.sendMessage(session.token, targetAccountId, responseBody)));
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
  }, [account, activeConversationId, canonicalSessionState, client, incrementLocalSessionUnread, mergeMessage, refreshCloudBridgeMessages, setCanonicalSessionState]);

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
    if (!account) return;
    for (const messages of Object.values(messagesByPeer)) {
      for (const message of messages) {
        const envelope = parseCloudGroupControl(message.body);
        if (!envelope) continue;
        if (message.fromAccountId === account.accountId) continue;
        if (processedCloudGroupControlIdsRef.current.has(message.messageId)) continue;
        processedCloudGroupControlIdsRef.current.add(message.messageId);
        void applyCloudGroupControl(message, envelope).catch((error) => {
          processedCloudGroupControlIdsRef.current.delete(message.messageId);
          // eslint-disable-next-line no-console
          console.warn('[cloud-group] sync failed', error);
        });
      }
    }
  }, [account, applyCloudGroupControl, messagesByPeer]);

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
        if (!cloudMessageMentionsLocalAgent(message.body, account, { allowFirstPerson: message.fromAccountId === account.accountId })) continue;
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
          const contact = contacts.contacts.find((candidate) => (candidate.bridgePeerNodeId || candidate.id.replace(/^cloud:/, '')) === peerId);
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
          const startedTurn = await startDesktopChatMessage(
            `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${account.accountId}:${peerId}`,
            prompt,
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
  }, [account, client, contacts.contacts, mergeMessage, messagesByPeer, refreshCloudBridgeMessages]);

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
    const generated = buildCloudDesktopBridgeState({
      account,
      contacts: contacts.contacts,
      messagesByPeer,
      readInboundMessageIdsByPeer,
      activeConversationId,
      localAgentTurnsByRequestId,
    });
    return mergeCloudBridgeState(generated, cloudBridgeOverride);
  }, [account, activeConversationId, cloudBridgeOverride, contacts.contacts, localAgentTurnsByRequestId, messagesByPeer, readInboundMessageIdsByPeer]);

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
    const targetAccountIds = [...new Set(input.targetAccountIds.map((value) => value.trim()).filter(Boolean))]
      .filter((accountId) => accountId !== account.accountId);
    if (targetAccountIds.length === 0) return;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const actor = input.actor ?? cloudGroupSelfParticipant(account, input.kind === 'group-message' ? 'person' : 'admin');
    const participants = input.participants?.length
      ? input.participants
      : cloudGroupParticipantsForBridgeSessionParticipants(account, input.bridgeParticipants ?? []);
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
      groupTitle: input.groupTitle ?? null,
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
  }, [account, client, mergeMessage, refreshCloudBridgeMessages]);

  const cancelCloudBridgeAgentRequest = useCallback(async (conversationId: string, requestId: string) => {
    const peerId = cloudPeerAccountIdFromConversationId(conversationId);
    const trimmedRequestId = requestId.trim();
    if (!peerId || !trimmedRequestId) throw new Error('Unable to resolve cloud agent request.');
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    const message = await client.sendMessage(session.token, peerId, encodeCloudAgentCancel({ requestId: trimmedRequestId }));
    mergeMessage(message);
    await refreshCloudBridgeMessages();
    setCloudBridgeOverrideState(null);
  }, [client, mergeMessage, refreshCloudBridgeMessages]);

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

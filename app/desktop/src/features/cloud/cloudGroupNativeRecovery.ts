import { fetchExistingCanonicalMessageSources } from '@/features/canonical/canonicalMessageSources';
import { loadChatSyncConversations, loadChatSyncMessagesPage, waitForCompleteChatSyncHistory } from '@/lib/desktopChatSync';
import type { CloudMessage } from './authClient';
import { cloudMessageFromChatSync } from './chatSyncMapping';
import type { ChatSyncConversation, ChatSyncMessage } from './chatSyncTypes';
import { parseCloudGroupControl, type CloudGroupControlEnvelope } from './cloudGroupMessages';
import { canonicalMessageSourceKey, cloudGroupCanonicalMessageSource } from './cloudMessageIndex';
import { cloudMessageMetadataOnly } from './cloudMessageCache';

const PAGE_SIZE = 100;
const CHUNK_SIZE = 10;

export async function recoverNativeCloudGroupHistory({
  accountId,
  prioritySessionId,
  applyControl,
  flushCanonicalState,
  onSessionSettled,
  shouldContinue,
}: {
  accountId: string;
  prioritySessionId?: string | null;
  applyControl: (
    wire: CloudMessage,
    envelope: CloudGroupControlEnvelope,
    options?: { deferPublish?: boolean; historyReplay?: boolean },
  ) => Promise<void>;
  flushCanonicalState: () => void;
  onSessionSettled: (sessionId: string) => void;
  shouldContinue: () => boolean;
}): Promise<boolean> {
  const applySnapshots = async (
    conversation: ChatSyncConversation,
    snapshots: ChatSyncMessage[],
    force = false,
  ) => {
    const rows = snapshots.flatMap((snapshot) => {
      const wire = cloudMessageMetadataOnly(
        cloudMessageFromChatSync(snapshot, conversation, accountId),
      );
      const envelope = parseCloudGroupControl(wire.body);
      return envelope ? [{ wire, envelope }] : [];
    });
    const sources = rows.flatMap((row) => {
      const source = cloudGroupCanonicalMessageSource(row.wire, row.envelope);
      return source ? [source] : [];
    });
    const existingKeys = new Set(
      (sources.length > 0
        ? await fetchExistingCanonicalMessageSources(sources)
        : []
      ).map(canonicalMessageSourceKey),
    );
    let applied = false;
    for (const row of rows) {
      if (!shouldContinue()) return false;
      const source = cloudGroupCanonicalMessageSource(row.wire, row.envelope);
      if (!force && source && existingKeys.has(canonicalMessageSourceKey(source))) continue;
      await applyControl(row.wire, row.envelope, {
        deferPublish: true,
        historyReplay: true,
      });
      applied = true;
    }
    return applied;
  };
  type GroupHistory = {
    conversation: ChatSyncConversation;
    sessionId: string;
    olderThroughSequence: number;
    latest: ChatSyncMessage[];
    head: ChatSyncMessage[];
  };
  const normalizedPrioritySessionId = prioritySessionId?.trim() ?? '';
  const conversationSessionId = (conversation: ChatSyncConversation) => (
    conversation.legacy_session_id?.trim() || conversation.id.trim()
  );
  const prioritizeConversations = (conversations: ChatSyncConversation[]) => (
    [...conversations].sort((left, right) => (
      Number(conversationSessionId(right) === normalizedPrioritySessionId)
      - Number(conversationSessionId(left) === normalizedPrioritySessionId)
      || Date.parse(right.updated_at) - Date.parse(left.updated_at)
    ))
  );
  const loadLatest = async (conversations: ChatSyncConversation[]) => {
    const histories: GroupHistory[] = [];
    for (const conversation of conversations) {
      if (!shouldContinue()) return null;
      const olderThroughSequence = Math.max(
        0,
        conversation.latest_message_sequence - PAGE_SIZE,
      );
      const page = await loadChatSyncMessagesPage(
        accountId,
        conversation.id,
        olderThroughSequence,
        PAGE_SIZE,
      );
      if (!page || !shouldContinue()) return null;
      histories.push({
        conversation,
        sessionId: conversationSessionId(conversation),
        olderThroughSequence,
        latest: page.messages,
        head: page.messages.slice(-1),
      });
    }
    return histories;
  };
  const initialConversations = prioritizeConversations(
    (await loadChatSyncConversations(accountId))
      .filter((conversation) => conversation.kind === 'group'),
  );
  const initialHistories = await loadLatest(initialConversations);
  if (!initialHistories) return false;
  const priorityHistory = initialHistories.find(
    (history) => history.sessionId === normalizedPrioritySessionId,
  ) ?? initialHistories[0] ?? null;
  if (priorityHistory) {
    const applied = await applySnapshots(
      priorityHistory.conversation,
      priorityHistory.latest,
    );
    if (!shouldContinue()) return false;
    if (applied) flushCanonicalState();
  }
  const backgroundHistories = initialHistories.filter(
    (history) => history !== priorityHistory,
  );
  for (const history of backgroundHistories) {
    const applied = await applySnapshots(history.conversation, history.head, true);
    if (!shouldContinue()) return false;
    if (applied) flushCanonicalState();
  }
  const initialRemainderCount = Math.max(
    0,
    ...backgroundHistories.map((history) => history.latest.length - 1),
  );
  for (let offset = 0; offset < initialRemainderCount; offset += CHUNK_SIZE) {
    let cursor = 0;
    await Promise.all(Array.from(
      { length: Math.min(2, backgroundHistories.length) },
      async () => {
        while (cursor < backgroundHistories.length) {
          const history = backgroundHistories[cursor];
          cursor += 1;
          const end = Math.max(0, history.latest.length - 1 - offset);
          const start = Math.max(0, end - CHUNK_SIZE);
          const applied = await applySnapshots(
            history.conversation,
            history.latest.slice(start, end),
          );
          if (!shouldContinue()) return;
          if (applied) flushCanonicalState();
        }
      },
    ));
    if (!shouldContinue()) return false;
  }
  const initiallyLoadedIdsByConversation = new Map(
    initialHistories.map((history) => [
      history.conversation.id,
      new Set(history.latest.map((message) => message.id)),
    ]),
  );
  const durableConversations = await waitForCompleteChatSyncHistory(accountId, shouldContinue);
  if (!durableConversations) return false;
  const histories = await loadLatest(prioritizeConversations(
    durableConversations.filter((conversation) => conversation.kind === 'group'),
  ));
  if (!histories) return false;
  for (const history of histories) {
    const applied = await applySnapshots(
      history.conversation,
      history.latest.slice(0, -1).filter((message) => (
        !initiallyLoadedIdsByConversation.get(history.conversation.id)?.has(message.id)
      )),
    );
    if (!shouldContinue()) return false;
    if (applied) flushCanonicalState();
  }
  for (const history of histories) {
    if (!shouldContinue()) return false;
    let afterSequence: number | null = null;
    let applied = false;
    while (history.olderThroughSequence > 0) {
      const page = await loadChatSyncMessagesPage(
        accountId,
        history.conversation.id,
        afterSequence,
        PAGE_SIZE,
      );
      if (!page || !shouldContinue()) return false;
      applied = await applySnapshots(
        history.conversation,
        page.messages.filter((snapshot) => (
          snapshot.conversation_sequence <= history.olderThroughSequence
        )),
      ) || applied;
      if (!shouldContinue()) return false;
      if (!page.hasMore) break;
      const next = page.nextAfterSequence;
      if (next === null || (afterSequence !== null && next <= afterSequence)) {
        throw new Error('Native group history did not advance its sequence cursor.');
      }
      if (next >= history.olderThroughSequence) break;
      afterSequence = next;
    }
    if (history.olderThroughSequence > 0 && history.head.length > 0) {
      applied = await applySnapshots(history.conversation, history.head, true) || applied;
    }
    if (!shouldContinue()) return false;
    if (applied) flushCanonicalState();
    onSessionSettled(history.sessionId);
  }
  return true;
}

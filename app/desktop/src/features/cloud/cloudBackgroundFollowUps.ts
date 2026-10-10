import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { cloudAgentLocalFailureMessage, waitForCloudAgentTurn } from './cloudAgentLocalExecution';

/**
 * When a background session finishes, the Mac runs one follow-up turn in the
 * parent session. Its reply is published into the conversation that asked for
 * the parent turn, as a separate agent reply keyed by the follow-up identity,
 * so it never replaces the parent's own reply.
 */
export type CloudBackgroundFollowUpReply = {
  /** The follow-up identity, used as the reply's request id. */
  requestId: string;
  text: string;
  deliveryState: 'complete' | 'failed' | 'cancelled';
  turn: DesktopChatTurnSnapshot;
};

export type CloudBackgroundFollowUpPublisher = (reply: CloudBackgroundFollowUpReply) => Promise<void>;

const MAX_PUBLISHERS = 64;
const publishersByParentRequestId = new Map<string, CloudBackgroundFollowUpPublisher>();
const startedFollowUpIds = new Set<string>();

/**
 * Registered by the direct and group executors of a cloud request; kept for
 * the newest requests only. Self-agent sessions synchronize the follow-up
 * reply through the forward sync instead.
 */
export function registerCloudBackgroundFollowUpPublisher(
  parentRequestId: string,
  publish: CloudBackgroundFollowUpPublisher,
) {
  const key = parentRequestId.trim();
  if (!key) return;
  publishersByParentRequestId.delete(key);
  publishersByParentRequestId.set(key, publish);
  while (publishersByParentRequestId.size > MAX_PUBLISHERS) {
    const oldest = publishersByParentRequestId.keys().next().value;
    if (oldest === undefined) break;
    publishersByParentRequestId.delete(oldest);
  }
}

export function cloudBackgroundFollowUpReply(turn: DesktopChatTurnSnapshot): CloudBackgroundFollowUpReply | null {
  const followUp = turn.backgroundFollowUp;
  if (!followUp || !turn.completed) return null;
  const text = turn.assistantText.trim();
  if (turn.status === 'cancelled') {
    return { requestId: followUp.id, text: text || 'Request stopped.', deliveryState: 'cancelled', turn };
  }
  if (turn.succeeded && text) return { requestId: followUp.id, text, deliveryState: 'complete', turn };
  return {
    requestId: followUp.id,
    text: cloudAgentLocalFailureMessage(turn.error || turn.message),
    deliveryState: 'failed',
    turn,
  };
}

/** Publishes a follow-up turn's reply once; returns whether it was published. */
export async function publishCloudBackgroundFollowUp(
  turn: DesktopChatTurnSnapshot,
  waitForTurn: (turnId: string) => Promise<DesktopChatTurnSnapshot> = waitForCloudAgentTurn,
): Promise<boolean> {
  const followUp = turn.backgroundFollowUp;
  const publish = publishersByParentRequestId.get(followUp?.parentRequestId?.trim() ?? '');
  if (!followUp || !publish || startedFollowUpIds.has(followUp.id)) return false;
  startedFollowUpIds.add(followUp.id);
  try {
    const reply = cloudBackgroundFollowUpReply(turn.completed ? turn : await waitForTurn(turn.id));
    if (!reply) return false;
    await publish(reply);
    return true;
  } catch {
    // A later discovery pass retries; the reply's client message id is stable.
    startedFollowUpIds.delete(followUp.id);
    return false;
  }
}

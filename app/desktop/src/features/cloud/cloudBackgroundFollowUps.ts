import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { MessageActionMetadata } from '@/kordi-app/types/message';
import { markDesktopBackgroundFollowUpPublished } from '@/lib/desktopBackgroundSessions';
import { cloudAgentLocalFailureMessage, waitForCloudAgentTurn } from './cloudAgentLocalExecution';
import type { CloudGroupControlEnvelope, CloudGroupParticipant } from './cloudGroupMessages';

/**
 * When a background session finishes, the Mac runs one follow-up turn in the
 * parent session. Its reply is published into the conversation that asked for
 * the parent turn, as a separate agent reply keyed by the follow-up identity,
 * so it never replaces the parent's own reply.
 *
 * The parent request registers a route with the native runtime when it
 * starts; the follow-up turn carries it back. A reloaded webview therefore
 * still knows where to publish, and the native runtime records when it did.
 */
export type CloudBackgroundFollowUpReply = {
  /** The follow-up identity, used as the reply's request id. */
  requestId: string;
  text: string;
  deliveryState: 'complete' | 'failed' | 'cancelled';
  turn: DesktopChatTurnSnapshot;
};

export type CloudDirectBackgroundFollowUpRoute = {
  kind: 'direct';
  accountId: string;
  peerId: string;
  sessionId: string | null;
  requestMessageId: string;
  messageAction: MessageActionMetadata | null;
};

export type CloudGroupBackgroundFollowUpRoute = {
  kind: 'group';
  accountId: string;
  /** The request envelope without its text, attachments or voice payload. */
  envelope: CloudGroupControlEnvelope;
  groupSpaceId: string;
  participants: CloudGroupParticipant[];
  targetAccountIds: string[];
  agentId: string;
  agentDisplayName: string;
};

export type CloudBackgroundFollowUpRoute = CloudDirectBackgroundFollowUpRoute | CloudGroupBackgroundFollowUpRoute;

type RouteOfKind<K extends CloudBackgroundFollowUpRoute['kind']> = Extract<CloudBackgroundFollowUpRoute, { kind: K }>;

/** Publishes one reply; resolves false when it cannot publish yet (signed out, other account). */
export type CloudBackgroundFollowUpHandler<K extends CloudBackgroundFollowUpRoute['kind']> = (
  route: RouteOfKind<K>,
  reply: CloudBackgroundFollowUpReply,
) => Promise<boolean>;

const handlers: { [K in CloudBackgroundFollowUpRoute['kind']]?: CloudBackgroundFollowUpHandler<K> } = {};
const startedFollowUpIds = new Set<string>();

/** Registered by the direct and group executors for the signed-in account. */
export function registerCloudBackgroundFollowUpHandler<K extends CloudBackgroundFollowUpRoute['kind']>(
  kind: K,
  handler: CloudBackgroundFollowUpHandler<K>,
): () => void {
  (handlers as Record<K, CloudBackgroundFollowUpHandler<K> | undefined>)[kind] = handler;
  return () => {
    if (handlers[kind] === handler) delete handlers[kind];
  };
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a route back from a follow-up turn; anything malformed is ignored. */
export function cloudBackgroundFollowUpRoute(value: unknown): CloudBackgroundFollowUpRoute | null {
  if (!record(value) || !text(value.accountId)) return null;
  if (value.kind === 'direct') {
    return text(value.peerId) && text(value.requestMessageId)
      ? value as CloudDirectBackgroundFollowUpRoute
      : null;
  }
  if (value.kind === 'group') {
    const envelope = value.envelope;
    return record(envelope) && text(envelope.groupId) && record(envelope.message) && text(envelope.message.id)
      && Array.isArray(value.participants) && Array.isArray(value.targetAccountIds)
      && value.targetAccountIds.length > 0 && text(value.agentId)
      ? value as CloudGroupBackgroundFollowUpRoute
      : null;
  }
  return null;
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

function handlerFor(route: CloudBackgroundFollowUpRoute) {
  return (route.kind === 'direct' ? handlers.direct : handlers.group) as
    | ((route: CloudBackgroundFollowUpRoute, reply: CloudBackgroundFollowUpReply) => Promise<boolean>)
    | undefined;
}

/** Publishes a follow-up turn's reply once; returns whether it was published. */
export async function publishCloudBackgroundFollowUp(
  turn: DesktopChatTurnSnapshot,
  {
    waitForTurn = waitForCloudAgentTurn,
    markPublished = markDesktopBackgroundFollowUpPublished,
  }: {
    waitForTurn?: (turnId: string) => Promise<DesktopChatTurnSnapshot>;
    markPublished?: (turnId: string) => Promise<unknown>;
  } = {},
): Promise<boolean> {
  const followUp = turn.backgroundFollowUp;
  if (!followUp || followUp.published || startedFollowUpIds.has(followUp.id)) return false;
  const route = cloudBackgroundFollowUpRoute(followUp.route);
  const publish = route ? handlerFor(route) : undefined;
  if (!route || !publish) return false;
  startedFollowUpIds.add(followUp.id);
  try {
    const reply = cloudBackgroundFollowUpReply(turn.completed ? turn : await waitForTurn(turn.id));
    if (!reply || !await publish(route, reply)) {
      startedFollowUpIds.delete(followUp.id);
      return false;
    }
  } catch {
    // A later discovery pass retries; the reply's client message id is stable.
    startedFollowUpIds.delete(followUp.id);
    return false;
  }
  // The id stays started, so this webview never publishes it again even when
  // the native record fails; a reload republishes under the same message id.
  await markPublished(turn.id).catch(() => undefined);
  return true;
}

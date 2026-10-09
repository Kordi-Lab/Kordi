import type { CloudMessage } from './authClient';
import type { MessageActionMetadata } from '@/kordi-app/types/message';
import { encodeCloudAgentResponse, type CloudAgentExecutionSnapshot } from './cloudAgentMessages';
import { cloudAgentExecutionSnapshotFromTurn } from './cloudAgentExecutionTrace';
import { CLOUD_SELF_AGENT_EXECUTION_STREAM_MS, CLOUD_SELF_AGENT_HEARTBEAT_MS } from './cloudSelfAgentForwardExecution';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

const SHARED_SUMMARY: Record<CloudAgentExecutionSnapshot['phase'], string> = {
  queued: 'Queued next', preparing: 'Preparing the response', analyzing: 'Analyzing the request',
  'using-tool': 'Using a tool', writing: 'Writing the response', complete: 'Execution complete',
  failed: 'Execution needs attention', cancelled: 'Execution canceled',
};

/** Shared chats carry status only, never the owner's private trace. */
export function cloudSharedAgentExecutionSnapshot(
  turn: DesktopChatTurnSnapshot | null, nowMs = Date.now(),
): CloudAgentExecutionSnapshot {
  const phase = turn ? cloudAgentExecutionSnapshotFromTurn(turn, nowMs).phase : 'preparing';
  return {
    phase, summary: SHARED_SUMMARY[phase], steps: [],
    ...(typeof turn?.startedAtMs === 'number' && Number.isFinite(turn.startedAtMs) ? { startedAtMs: turn.startedAtMs } : {}),
    updatedAtMs: nowMs, completed: phase === 'complete' || phase === 'failed' || phase === 'cancelled',
  };
}

type Publish = (body: string, clientMessageId: string) => Promise<CloudMessage>;

/**
 * Publishes the processing reply for a mention this Mac runs in a person or
 * group chat, as the self-agent path does: one row at admission, then phase
 * changes at the stream cadence and a heartbeat while nothing changes. The
 * terminal reply shares the request id, so readers replace this row with it.
 */
export function createCloudSharedAgentProgress({
  requestId, messageAction = null, publish, onPublished, onError, now = Date.now,
}: {
  requestId: string;
  messageAction?: MessageActionMetadata | null;
  publish: Publish;
  onPublished: (message: CloudMessage) => void;
  onError: (error: unknown) => void;
  now?: () => number;
}) {
  let chain: Promise<void> = Promise.resolve();
  let lastPublishedAtMs = 0;
  let lastPhase: string | null = null;
  let lastTurn: DesktopChatTurnSnapshot | null = null;
  let revision = 0;
  let stopped = false;
  const send = (turn: DesktopChatTurnSnapshot | null, clientMessageId: string) => {
    const nowMs = now();
    const execution = cloudSharedAgentExecutionSnapshot(turn, nowMs);
    lastPublishedAtMs = nowMs;
    lastPhase = execution.phase;
    const body = encodeCloudAgentResponse({ requestId, text: '', deliveryState: 'processing', execution, messageAction });
    chain = chain.then(async () => {
      if (stopped) return;
      onPublished(await publish(body, clientMessageId));
    }).catch(onError);
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  return {
    /** Call once the run is admitted; `finish` must follow. */
    start() {
      send(null, `shared:${requestId}:processing`);
      heartbeat ??= setInterval(() => {
        if (stopped || now() - lastPublishedAtMs < CLOUD_SELF_AGENT_HEARTBEAT_MS) return;
        send(lastTurn, `shared:${requestId}:processing:${Math.floor(now() / CLOUD_SELF_AGENT_HEARTBEAT_MS)}`);
      }, CLOUD_SELF_AGENT_HEARTBEAT_MS);
    },
    update(turn: DesktopChatTurnSnapshot) {
      if (stopped || turn.completed) return;
      lastTurn = turn;
      const phase = cloudSharedAgentExecutionSnapshot(turn, now()).phase;
      if (phase === lastPhase || now() - lastPublishedAtMs < CLOUD_SELF_AGENT_EXECUTION_STREAM_MS) return;
      revision += 1;
      send(turn, `shared:${requestId}:execution:${revision}`);
    },
    /** Lets queued progress land before the terminal reply, then stops. */
    async finish() {
      clearInterval(heartbeat);
      await chain;
      stopped = true;
    },
  };
}

import type { CloudAgentRunClaimInput, CloudAuthClient, CloudMessage, SendCloudMessageOptions } from './authClient';
import { cloudOperationUuid } from './chatSyncMapping';
import { cancelDesktopChatTurn, renewDesktopChatExecutionLease } from '@/lib/desktop';
import type { DesktopChatContextMessage } from '@/lib/desktop';

// The native deadline is shorter than the server lease, including network delay.
export const DESKTOP_EXECUTION_WATCHDOG_MS = 30_000;
/** Context contract 2: this executor uses the history the server sends with a
 * claim (`serverContext`), which applies the conversation's AI access settings. */
export const DESKTOP_CONTEXT_CONTRACT = 2;

export type DesktopServerContext = {
  historyScope: 'mentions' | 'recent';
  messages: DesktopChatContextMessage[];
};

/** Maps the claim's `serverContext`. Once the server sends one, only its
 * messages may be used as history, even when some entries are malformed. */
export function desktopServerContext(value: unknown): DesktopServerContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const context = value as { historyScope?: unknown; messages?: unknown };
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return {
    historyScope: context.historyScope === 'recent' ? 'recent' : 'mentions',
    messages: messages.flatMap((entry): DesktopChatContextMessage[] => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!id || !text) return [];
      return [{
        id: `server-context:${id}`,
        authorName: typeof item.authorName === 'string' && item.authorName.trim() ? item.authorName.trim() : 'Participant',
        authorKind: item.authorKind === 'agent' ? 'agent' : 'human',
        text,
        createdAtMs: typeof item.createdAtMs === 'number' ? item.createdAtMs : null,
      }];
    }),
  };
}

export async function acquireDesktopExecutionLease(client: Pick<CloudAuthClient, 'desktopAgentExecution'>, token: string, input: CloudAgentRunClaimInput) {
  const claimId = crypto.randomUUID();
  const started = Date.now();
  const result = await client.desktopAgentExecution<{runId: string; acquired: boolean; contextSessionId?: string; turnIdentity?: Record<string, unknown>; serverContext?: unknown}>(
    token, 'claim', { ...input, claimId, contextContract: DESKTOP_CONTEXT_CONTRACT });
  // Another executor owns the run, or the server sent it elsewhere: stay quiet.
  if (!result.acquired) return null;
  const serverContext = desktopServerContext(result.serverContext);
  if (!result.turnIdentity || result.turnIdentity.ownerAccountId !== input.ownerAccountId
    || result.turnIdentity.requesterAccountId !== input.requesterAccountId) {
    throw new Error('The execution lease did not provide a matching runtime identity.');
  }
  const identityMessage: DesktopChatContextMessage = {
    id: `runtime-identity:${result.runId}`, authorName: 'Kordi runtime', authorKind: 'agent',
    contextRole: 'runtimeIdentity', text: JSON.stringify(result.turnIdentity),
    executionLease: { runId: result.runId, claimId, ownerAccountId: input.ownerAccountId, sessionId: result.contextSessionId ?? input.sessionId },
  };
  let deadline = started + DESKTOP_EXECUTION_WATCHDOG_MS;
  let turnId: string | null = null;
  let lost = false;
  let disposed = false;
  let renewing = false;
  const loseLease = () => {
    lost = true;
    if (turnId) void cancelDesktopChatTurn(turnId).catch(() => undefined);
  };
  const timer = setInterval(() => {
    if (lost || disposed || renewing) return;
    if (deadline <= Date.now()) { loseLease(); return; }
    renewing = true;
    const sentAt = Date.now();
    void client.desktopAgentExecution(token, `${encodeURIComponent(result.runId)}/renew`, { claimId })
      .then(async () => {
        if (lost || disposed) return;
        deadline = sentAt + DESKTOP_EXECUTION_WATCHDOG_MS;
        if (deadline <= Date.now()) throw new Error('Execution lease expired during renewal.');
        if (turnId) await renewDesktopChatExecutionLease(turnId, deadline);
      }).catch(loseLease).finally(() => { renewing = false; });
  }, 10_000);
  return {
    /** The server-built history when the server sent one. */
    serverContext,
    /** History for this run: the server's when present, else the local cache's. */
    history(local: readonly DesktopChatContextMessage[]): DesktopChatContextMessage[] {
      return serverContext ? serverContext.messages : [...local];
    },
    contextMessages(messages: readonly DesktopChatContextMessage[]) {
      // Requester-dependent group policy now travels in the frozen turn identity,
      // never in the system header. Custom Agent definitions remain unchanged.
      return [...messages.filter(message => !message.id.startsWith('cloud-group-persona:')
        && !message.id.startsWith('requester:')), identityMessage];
    },
    get deadline() { if (lost || deadline <= Date.now()) throw new Error('Execution lease lost.'); return deadline; },
    attach(id: string) { turnId = id; if (lost || deadline <= Date.now()) loseLease(); },
    async admitted() {
      if (lost || deadline <= Date.now()) { loseLease(); throw new Error('Execution lease lost.'); }
      return (await client.desktopAgentExecution<{admitted:boolean}>(token, `${encodeURIComponent(result.runId)}/admit`, { claimId })).admitted;
    },
    dispose() { disposed = true; clearInterval(timer); },
    async cancel() {
      if (lost || disposed) return;
      await client.desktopAgentExecution(token, `${encodeURIComponent(result.runId)}/cancel`, { claimId });
    },
    publisher: {
      sendMessage: async (_token: string, _peer: string, body: string, options: SendCloudMessageOptions = {}): Promise<CloudMessage> => {
        if (lost || deadline <= Date.now()) { loseLease(); throw new Error('Execution lease lost.'); }
        return client.desktopAgentExecution(token, `${encodeURIComponent(result.runId)}/progress`, {
          claimId, body, clientMessageId: cloudOperationUuid(options.clientMessageId),
        });
      },
    },
  };
}

import type { CloudAgentRunClaimInput, CloudAuthClient, CloudMessage, SendCloudMessageOptions } from './authClient';
import { cloudOperationUuid } from './chatSyncMapping';
import { cancelDesktopChatTurn, renewDesktopChatExecutionLease } from '@/lib/desktop';

// The native deadline is shorter than the server lease, including network delay.
export const DESKTOP_EXECUTION_WATCHDOG_MS = 30_000;

export async function acquireDesktopExecutionLease(client: Pick<CloudAuthClient, 'desktopAgentExecution'>, token: string, input: CloudAgentRunClaimInput) {
  const claimId = crypto.randomUUID();
  const started = Date.now();
  const result = await client.desktopAgentExecution<{runId: string; acquired: boolean}>(token, 'claim', { ...input, claimId });
  if (!result.acquired) return null;
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
    get deadline() { if (lost || deadline <= Date.now()) throw new Error('Execution lease lost.'); return deadline; },
    attach(id: string) { turnId = id; if (lost || deadline <= Date.now()) loseLease(); },
    async admitted() {
      if (lost || deadline <= Date.now()) { loseLease(); throw new Error('Execution lease lost.'); }
      return (await client.desktopAgentExecution<{admitted:boolean}>(token, `${encodeURIComponent(result.runId)}/admit`, { claimId })).admitted;
    },
    dispose() { disposed = true; clearInterval(timer); },
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

import type { Dispatch, SetStateAction } from 'react';

import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { CloudAuthClient } from './authClient';
import { isCloudAgentHostedCredentialUnavailableError } from './cloudAgentFailureNotices';
import { handBackDesktopRun, type HandBackLease } from './cloudDesktopRunHandback';

/**
 * Whether a Mac turn ended before the model ran because this Mac could not
 * load the owner's hosted account. The cloud runner resolves that account on
 * the server, so the run is handed back instead of failing for everyone.
 */
export function desktopTurnNeedsCloudHandBack(
  turn: Pick<DesktopChatTurnSnapshot, 'status' | 'succeeded' | 'assistantText' | 'tools' | 'error' | 'message'>,
): boolean {
  return turn.status === 'failed'
    && !turn.succeeded
    && !turn.assistantText?.trim()
    && turn.tools.length === 0
    && isCloudAgentHostedCredentialUnavailableError(turn.error || turn.message);
}

/** What a hand-back needs from the executor that claimed the run. */
export type HostedCredentialHandBackHost = {
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  setLocalTurns: Dispatch<SetStateAction<Record<string, DesktopChatTurnSnapshot>>>;
  syncDiff: () => Promise<unknown>;
};

/**
 * Hands a claimed shared run to the cloud runner when its Mac turn ended
 * without the owner's hosted account. On success the failed local turn is
 * removed, so the cloud reply replaces it, and the conversation is synced.
 * Returns `false`, changing nothing, when the run stays with this Mac.
 */
export async function handBackHostedCredentialTurn(
  host: HostedCredentialHandBackHost,
  token: string,
  lease: HandBackLease,
  turn: DesktopChatTurnSnapshot,
  requestId: string,
): Promise<boolean> {
  if (!desktopTurnNeedsCloudHandBack(turn) || !await handBackDesktopRun(host.client, token, lease)) return false;
  host.setLocalTurns((current) => {
    if (!(requestId in current)) return current;
    const next = { ...current };
    delete next[requestId];
    return next;
  });
  void host.syncDiff().catch(() => undefined);
  return true;
}

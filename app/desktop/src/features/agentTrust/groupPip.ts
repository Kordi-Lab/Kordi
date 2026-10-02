// PiP for groups created on this Mac: turned on right after creation when the
// creator asks, and carried over to new channels of a group that has it.
import { normalizeAiAccess } from '@/features/cloud/agentTrustClient';
import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';

import { AI_ACCESS_COPY } from './aiAccessCopy';
import { defaultAgentTrustApi, type AgentTrustApi } from './agentTrustApi';

async function token(api: AgentTrustApi): Promise<string> {
  const session = await api.session();
  if (!session) throw new Error('Not signed in.');
  return session.token;
}

/** Whether the snapshot a PiP change returned shows PiP on. The setting can
 * commit while PiP itself fails to join; the server then reports PiP off. A
 * snapshot without AI access (an older server) counts as on. */
function pipTurnedOn(conversation: ChatSyncConversation | null | undefined): boolean {
  return normalizeAiAccess(conversation?.ai_access)?.pip?.enabled !== false;
}

/** Turns PiP on in a group that was just created. The group stays either
 * way; a failure is reported with the AI access copy. */
export async function enablePipForNewGroup(
  sessionId: string,
  reportError: (message: string) => void,
  api: AgentTrustApi = defaultAgentTrustApi(),
): Promise<boolean> {
  try {
    const conversation = await api.calls.updateAiAccess(await token(api), sessionId, { pip_enabled: true });
    if (pipTurnedOn(conversation)) return true;
  } catch {
    // Reported below.
  }
  reportError(AI_ACCESS_COPY.createPipFailure);
  return false;
}

/**
 * Best effort: a new channel gets PiP when the channel it came from has it.
 * A failure is never shown; the channel works without PiP, and anyone who
 * manages it can turn PiP on in AI access.
 */
export async function inheritPipForChannel(
  sourceSessionId: string | null | undefined,
  sessionId: string,
  api: AgentTrustApi = defaultAgentTrustApi(),
  onFailure: (error: unknown) => void = () => undefined,
): Promise<boolean> {
  const source = sourceSessionId?.trim();
  if (!source || source === sessionId) return false;
  try {
    const sessionToken = await token(api);
    const access = await api.calls.aiAccess(sessionToken, source);
    if (!access?.pip?.enabled) return false;
    const conversation = await api.calls.updateAiAccess(sessionToken, sessionId, { pip_enabled: true });
    if (pipTurnedOn(conversation)) return true;
    onFailure(new Error('PiP could not join the new channel.'));
    return false;
  } catch (error) {
    onFailure(error);
    return false;
  }
}

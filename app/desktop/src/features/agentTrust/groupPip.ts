// PiP for groups created on this Mac: turned on right after creation when the
// creator asks, and carried over to new channels of a group that has it.
import { AI_ACCESS_COPY } from './aiAccessCopy';
import { defaultAgentTrustApi, type AgentTrustApi } from './agentTrustApi';

async function token(api: AgentTrustApi): Promise<string> {
  const session = await api.session();
  if (!session) throw new Error('Not signed in.');
  return session.token;
}

/** Turns PiP on in a group that was just created. The group stays either
 * way; a failure is reported with the AI access copy. */
export async function enablePipForNewGroup(
  sessionId: string,
  reportError: (message: string) => void,
  api: AgentTrustApi = defaultAgentTrustApi(),
): Promise<boolean> {
  try {
    await api.calls.updateAiAccess(await token(api), sessionId, { pip_enabled: true });
    return true;
  } catch {
    reportError(AI_ACCESS_COPY.createPipFailure);
    return false;
  }
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
    await api.calls.updateAiAccess(sessionToken, sessionId, { pip_enabled: true });
    return true;
  } catch (error) {
    onFailure(error);
    return false;
  }
}

/** The System agent, the built-in plan agent. Its account is system-managed on the server, and the
 * client shows its messages and cards as System with the gray Kordi bird. */
// The stored ids keep the agent's old name.
export const KORDI_SYSTEM_AGENT_ACCOUNT_ID = 'acct_kordi_pip';
export const KORDI_SYSTEM_AGENT_CLOUD_AGENT_ID = 'cloud_agent_kordi_pip';

/** The System agent's canonical identity, by the Cloud account or agent id it was created from. */
export function isSystemAgentIdentity(identity: { humanId?: string | null; agentId?: string | null; sourceIdentityId?: string | null } | null | undefined): boolean {
  if (!identity) return false;
  return identity.humanId === KORDI_SYSTEM_AGENT_ACCOUNT_ID
    || identity.agentId === KORDI_SYSTEM_AGENT_CLOUD_AGENT_ID
    || identity.sourceIdentityId === KORDI_SYSTEM_AGENT_ACCOUNT_ID;
}

/** The System agent posts in group chats but is not a member for counts, titles, or read receipts. */
export function isSystemAgentAccountId(accountId: string | null | undefined): boolean {
  return accountId?.trim() === KORDI_SYSTEM_AGENT_ACCOUNT_ID;
}

/** Server notices in group chats (introductions, joins) and the plan agent's messages show as
 * System with a gray Kordi bird, whichever built-in account posted them. */
export const KORDI_SYSTEM_NOTICE_KIND = 'system-notice';
export const KORDI_SYSTEM_NAME = 'System';
export const KORDI_SYSTEM_AVATAR_URL = '/kordi-system-avatar.svg';

export function isSystemAvatarUrl(url: string | null | undefined): boolean {
  return url?.trim() === KORDI_SYSTEM_AVATAR_URL;
}

/** The hidden service account that posts Grounding notices. Like the System agent, it is
 * server-managed: never a counted member, participant, peer, or contact. */
export const KORDI_SYSTEM_ACCOUNT_ID = 'acct_kordi_system';

export function isSystemAccountId(accountId: string | null | undefined): boolean {
  return accountId?.trim() === KORDI_SYSTEM_ACCOUNT_ID;
}

/** The System agent or the system account: server-managed members a client never lists or removes. */
export function isBuiltInAccountId(accountId: string | null | undefined): boolean {
  return isSystemAgentAccountId(accountId) || isSystemAccountId(accountId);
}

/** A canonical identity created from the System agent or the system account. */
export function isBuiltInIdentity(identity: { humanId?: string | null; agentId?: string | null; sourceIdentityId?: string | null } | null | undefined): boolean {
  return isSystemAgentIdentity(identity) || isSystemAccountId(identity?.humanId) || isSystemAccountId(identity?.sourceIdentityId);
}

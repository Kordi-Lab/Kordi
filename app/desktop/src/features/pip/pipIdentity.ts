/** Pip, the built-in plan agent. Its account is system-managed on the server;
 * the client substitutes Pip's own mark and label for that account id. */
export const KORDI_PIP_ACCOUNT_ID = 'acct_kordi_pip';
export const KORDI_PIP_AGENT_ID = 'cloud_agent_kordi_pip';
export const KORDI_PIP_NAME = 'Pip';
export const KORDI_PIP_TAG = 'Built-in agent';
export const KORDI_PIP_AVATAR_URL = '/kordi-pip-avatar.svg';

export function isPipAvatarUrl(url: string | null | undefined): boolean {
  return url?.trim() === KORDI_PIP_AVATAR_URL;
}

/** Pip's canonical identity, by the Cloud account or agent id it was created from. */
export function isPipIdentity(identity: { humanId?: string | null; agentId?: string | null; sourceIdentityId?: string | null } | null | undefined): boolean {
  if (!identity) return false;
  return identity.humanId === KORDI_PIP_ACCOUNT_ID
    || identity.agentId === KORDI_PIP_AGENT_ID
    || identity.sourceIdentityId === KORDI_PIP_ACCOUNT_ID;
}

/** Pip posts in group chats but is not a member for counts, titles, or read receipts. */
export function isPipAccountId(accountId: string | null | undefined): boolean {
  return accountId?.trim() === KORDI_PIP_ACCOUNT_ID;
}

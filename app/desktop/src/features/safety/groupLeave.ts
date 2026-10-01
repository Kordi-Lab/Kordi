// Leaving a group: who may leave, what the confirmation says, who takes
// over from a leaving owner, and the order of the leave steps.

import { CloudAuthError, isRetryableCloudDeliveryError } from '@/features/cloud/cloudAuthError';

import { isMissingRoute } from './safetyClient';

export { useSafetyActions } from './safetyActions';

export const LEAVE_GROUP_ERROR = "Couldn't leave the group. Check your connection and try again.";
export const LEAVE_GROUP_UNAVAILABLE = "Leaving groups isn't available yet. Try again after Kordi updates.";

export function leaveGroupPrompt(groupName: string, isOwner: boolean, successorName?: string | null): string {
  const name = groupName.trim() || 'this group';
  const prompt = `Leave ${name}? You'll stop getting messages from this group and all of its channels, `
    + "and it will be removed from your devices. To come back, you'll need an invite link from someone in the group.";
  if (!isOwner) return prompt;
  return `${prompt} You're the group owner, so ${successorName?.trim() || 'another member'} will become the owner.`;
}

/**
 * Anyone may leave, except that the creator needs a server that hands the
 * group to a successor. Admins remove other non-admin members as before.
 */
export function memberCanBeRemoved({
  isSelf,
  isCreator,
  admin,
  canManageMembers,
  safetyFeaturesAvailable,
}: {
  isSelf: boolean;
  isCreator: boolean;
  admin: boolean;
  canManageMembers: boolean;
  safetyFeaturesAvailable: boolean;
}): boolean {
  return isSelf ? (!isCreator || safetyFeaturesAvailable) : (!isCreator && canManageMembers && !admin);
}

export type SelfLeaveMode = 'server' | 'envelope-only' | 'unavailable';

/**
 * How a person leaves a group. The server leave is tried unless the server is
 * known to lack it (an empty 404 from the block list), so a block list that
 * failed to load does not quietly skip the server; a leave that then finds no
 * route still falls back to envelopes. The creator needs confirmed support,
 * because on an older server nobody would take the group over.
 */
export function selfLeaveMode({
  isCreator,
  serverSupport,
}: {
  isCreator: boolean;
  /** The block list store's state, or null without a signed-in account. */
  serverSupport: { loaded: boolean; available: boolean } | null;
}): SelfLeaveMode {
  if (isCreator) return serverSupport?.loaded && serverSupport.available ? 'server' : 'unavailable';
  return serverSupport?.available ? 'server' : 'envelope-only';
}

export type LeaveSuccessorCandidate = {
  identityId: string;
  accountId: string;
  name: string;
};

type ServerMember = { account_id: string; membership_state: string; joined_at: string };

/** The first group admin, else the earliest-joined active member, else anyone left. */
export function chooseLeaveSuccessor({
  candidates,
  adminIdentityIds,
  serverMembers = [],
}: {
  candidates: readonly LeaveSuccessorCandidate[];
  adminIdentityIds: readonly string[];
  serverMembers?: readonly ServerMember[];
}): LeaveSuccessorCandidate | null {
  for (const adminId of adminIdentityIds) {
    const admin = candidates.find((candidate) => candidate.identityId === adminId);
    if (admin) return admin;
  }
  const byJoinOrder = serverMembers
    .filter((member) => member.membership_state === 'active')
    .slice()
    .sort((left, right) => (
      left.joined_at.localeCompare(right.joined_at) || left.account_id.localeCompare(right.account_id)
    ));
  for (const member of byJoinOrder) {
    const candidate = candidates.find((item) => item.accountId === member.account_id);
    if (candidate) return candidate;
  }
  return candidates[0] ?? null;
}

export type GroupLeaveSteps = {
  /** Whether the leaver owns the group and therefore hands it on. */
  isOwner: boolean;
  /** Tells the other members, channel by channel, through group envelopes. */
  sendLeaveEnvelopes(this: void): Promise<unknown>;
  /** Leaves on the server, once, on the group's main conversation. */
  leaveOnServer(this: void): Promise<unknown>;
  removeLocally(this: void): Promise<void>;
};

/**
 * Runs a leave in a fixed order: envelopes, then the server, then this
 * device. A connection problem stops it before anything changes here. A
 * server without the leave route keeps the older envelope-only leave, which
 * an owner cannot use because nobody would take over the group.
 */
export async function runGroupLeave(steps: GroupLeaveSteps): Promise<'left' | 'envelope-only'> {
  try {
    await steps.sendLeaveEnvelopes();
  } catch (error) {
    if (isRetryableCloudDeliveryError(error)) throw new Error(LEAVE_GROUP_ERROR);
    // A refused envelope (for example to a member the server no longer
    // lists) does not stop the leave itself.
  }
  let outcome: 'left' | 'envelope-only' = 'left';
  try {
    await steps.leaveOnServer();
  } catch (error) {
    if (isMissingRoute(error)) {
      if (steps.isOwner) throw new Error(LEAVE_GROUP_UNAVAILABLE);
      outcome = 'envelope-only';
    } else if (!isAlreadyGone(error)) {
      throw new Error(LEAVE_GROUP_ERROR);
    }
  }
  await steps.removeLocally();
  return outcome;
}

/** The server has no membership to end, so only this device needs updating. */
function isAlreadyGone(error: unknown): boolean {
  return error instanceof CloudAuthError
    && (error.code === 'CHAT_ENTITY_NOT_FOUND' || error.code === 'CHAT_FORBIDDEN');
}

/**
 * Copy and rules for creating and sharing a group. Failures get short, human
 * copy: server messages such as "group member count is invalid" never reach
 * the screen.
 */

/** A group needs a name before it can be created or shared. */
export function groupNameIsValid(name: string | null | undefined) {
  return Boolean(name?.trim());
}

/** "Expires in 7 days" for an invitation link, rounded to whole days. */
export function invitationExpiryLabel(expiresAt: string, nowMs = Date.now()) {
  const remaining = Date.parse(expiresAt) - nowMs;
  const days = Number.isFinite(remaining) ? Math.max(1, Math.round(remaining / 86_400_000)) : 7;
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}

const OFFLINE = "Couldn't reach Kordi. Check your connection and try again.";

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : typeof error === 'string' ? error : '').toLowerCase();
}

function isOffline(text: string) {
  return /failed to fetch|network|offline|timed out|timeout|load failed|could not connect/.test(text);
}

export function groupCreationErrorMessage(error: unknown): string {
  const text = errorText(error);
  if (isOffline(text)) return OFFLINE;
  if (/blocked|can't message/.test(text)) return "One of these people can't be added.";
  if (/approve people as contacts/.test(text)) return 'Approve people as contacts before adding them to a group.';
  if (/sign in/.test(text)) return 'Sign in to Kordi to start a group.';
  return "Couldn't create the group. Try again.";
}

/** `asCreator`: the person who just created the group is always its admin. */
export function groupInvitationLinkErrorMessage(error: unknown, { asCreator = false } = {}): string {
  const text = errorText(error);
  if (isOffline(text)) return OFFLINE;
  if (!asCreator && /admin|permission|not allowed|forbidden/.test(text)) return 'Only group admins can share a link.';
  // Known server refusals get their own short line, so a failure names its cause.
  if (/enter a group name/.test(text)) return 'Name the group before sharing a link.';
  if (/cannot create a share link/.test(text)) return "This group can't share a link yet. Try again in a moment.";
  if (/member count|fewer than|at least/.test(text)) return 'Add someone to the group before sharing a link.';
  if (/too many|rate limit|429/.test(text)) return 'Too many links right now. Try again later.';
  return "Couldn't create the link. Try again.";
}

export function groupDissolveErrorMessage(error: unknown, scope: 'group' | 'channel'): string {
  const text = errorText(error);
  if (isOffline(text)) return OFFLINE;
  if (/not allowed|forbidden|admin/.test(text)) return `Only group admins can dissolve this ${scope}.`;
  return `Couldn't dissolve the ${scope}. Try again.`;
}

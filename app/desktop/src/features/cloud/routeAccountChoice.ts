// Account choices name one saved account. They are identifiers, never secrets,
// so routes carry them unchanged; when the account is gone the route stays
// attached to it until the owner picks another one explicitly.

export const ACCOUNT_UNAVAILABLE_LABEL = 'Account unavailable';

/** Prefixes of choices that name one specific saved account. */
export const ACCOUNT_CHOICE_PREFIXES = ['profile:', 'ios-codex:', 'ios-api-key:', 'cloud-api-key:', 'cloud-login:'] as const;

/** Choices that mean "whichever account is active on this device". */
export const DEVICE_ACTIVE_CHOICES = new Set(['local-active-oauth', 'local-active-api-key', 'ios-api-key']);

export function isAccountAuthChoice(choice?: string | null) {
  const value = choice?.trim() ?? '';
  return ACCOUNT_CHOICE_PREFIXES.some((prefix) => value.startsWith(prefix) && value.length > prefix.length);
}

/** Prefixes of accounts stored only in the Kordi account: hosted keys and sign-ins, and iOS accounts. */
export const HOSTED_ONLY_CHOICE_PREFIXES = ['cloud-api-key:', 'cloud-login:', 'ios-codex:', 'ios-api-key:'] as const;

/** A choice whose prefix alone says the account is stored only in the Kordi account. */
export function hasHostedOnlyPrefix(choice?: string | null) {
  const value = choice?.trim() ?? '';
  return HOSTED_ONLY_CHOICE_PREFIXES.some((prefix) => value.startsWith(prefix) && value.length > prefix.length);
}

/**
 * A hosted-only account has no credential on this Mac, so its turns run on
 * the Kordi Cloud runner, which receives the credential for the claimed run
 * only. That is a hosted-only prefix, or a hosted copy (for example a
 * `profile:` sign-in published from another Mac) with no local counterpart.
 * A null `localChoices` means this Mac's accounts have not loaded yet; a hosted
 * copy then never counts as hosted-only, so it cannot leave this Mac by mistake.
 */
export function isHostedOnlyAccountChoice(
  choice?: string | null,
  accounts: { hostedChoices?: Iterable<string>; localChoices?: Iterable<string> | null } = {},
) {
  const value = choice?.trim() ?? '';
  if (hasHostedOnlyPrefix(value)) return true;
  if (!value || !accounts.hostedChoices || accounts.localChoices === null) return false;
  const hosted = new Set(accounts.hostedChoices);
  const local = new Set(accounts.localChoices ?? []);
  return hosted.has(value) && !local.has(value);
}

/** Longest account label the client publishes; the server truncates too. */
export const ACCOUNT_LABEL_MAX_LENGTH = 80;

export function publishableAccountLabel<T extends string | null | undefined>(label: T): T {
  if (typeof label !== 'string') return label;
  const trimmed = label.trim();
  const characters = [...trimmed];
  return (characters.length > ACCOUNT_LABEL_MAX_LENGTH
    ? characters.slice(0, ACCOUNT_LABEL_MAX_LENGTH).join('').trimEnd()
    : trimmed) as T;
}

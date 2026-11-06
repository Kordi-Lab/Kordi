import { providerShortName } from './providerCopy';

/** A provider account ID, such as the ChatGPT account UUID older Macs saved as the name. */
const OPAQUE_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOpaqueAccountLabel(label: string | null | undefined) {
  return OPAQUE_ACCOUNT_ID.test(label?.trim() ?? '');
}

function shortDate(value: string | null | undefined, timeZone?: string) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(date);
}

/**
 * The name a saved account shows. A name that is only an account ID reads as
 * the provider and the day the account was saved, for example
 * "ChatGPT account · Oct 26". Returns null when the account has no name.
 */
export function readableAccountLabel(
  label: string | null | undefined,
  providerName: string | null | undefined,
  createdAt?: string | null,
  timeZone?: string,
) {
  const trimmed = label?.trim() ?? '';
  if (!trimmed) return null;
  if (!isOpaqueAccountLabel(trimmed)) return trimmed;
  const provider = providerName?.trim() ? providerShortName(providerName) : '';
  const name = provider ? `${provider} account` : 'Saved account';
  const day = shortDate(createdAt, timeZone);
  return day ? `${name} · ${day}` : name;
}

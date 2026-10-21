import type { CloudAccount, CloudProfileUpdateInput } from '@/features/cloud/authClient';
import { CloudAuthError } from '@/features/cloud/cloudAuthError';
import type { CanonicalAvatarMutation } from '@/features/cloud/canonicalAvatar';
import { normalizeKordiId } from '@/features/cloud/kordiId';

/** Optional profile fields, each sent as a string where "" clears it. */
export const CLOUD_PROFILE_FIELDS = ['kordiId', 'about', 'location', 'timeZone', 'website', 'birthday'] as const;
export type CloudProfileField = (typeof CLOUD_PROFILE_FIELDS)[number];
export type CloudProfileFieldDraft = Record<CloudProfileField, string>;
/** Where a save error is shown: under one row, or under the Save row. */
export type CloudProfileErrorTarget = CloudProfileField | 'displayName' | 'form';

export const CLOUD_PROFILE_LIMITS = { kordiId: 30, about: 280, location: 80, website: 200 } as const;
export const BIRTHDAY_MIN = '1900-01-01';

const ERROR_FIELDS: Record<string, CloudProfileField> = {
  invalid_kordi_id: 'kordiId',
  kordi_id_taken: 'kordiId',
  kordi_id_change_locked: 'kordiId',
  invalid_about: 'about',
  invalid_location: 'location',
  invalid_time_zone: 'timeZone',
  invalid_website: 'website',
  invalid_birthday: 'birthday',
};

/** A nine-digit number is the default ID, so only a chosen handle fills the field. */
export function cloudProfileHandleDraft(kordiId: string | null | undefined): string {
  const normalized = normalizeKordiId(kordiId);
  return normalized && !/^\d+$/.test(normalized) ? normalized : '';
}

/** The account number shown when no handle is chosen. */
export function cloudProfileNumberPlaceholder(account: Pick<CloudAccount, 'kordiId' | 'accountNumber'> | null): string {
  const number = account?.accountNumber?.trim();
  if (number) return number;
  const normalized = normalizeKordiId(account?.kordiId);
  return normalized && /^\d+$/.test(normalized) ? normalized : 'Account number';
}

/** "Month D, YYYY" when the Kordi ID cannot change until a future time, else null. */
export function kordiIdLockedUntilLabel(
  account: Pick<CloudAccount, 'kordiIdChangeAvailableAt'> | null,
  now = Date.now(),
): string | null {
  const at = Date.parse(account?.kordiIdChangeAvailableAt ?? '');
  if (Number.isNaN(at) || at <= now) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(at);
}

export function sanitizeKordiHandleInput(value: string): string {
  return value.replace(/^@+/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, CLOUD_PROFILE_LIMITS.kordiId);
}

export function cloudProfileFieldDraft(account: CloudAccount | null): CloudProfileFieldDraft {
  return {
    kordiId: cloudProfileHandleDraft(account?.kordiId),
    about: account?.about?.trim() ?? '',
    location: account?.location?.trim() ?? '',
    timeZone: account?.timeZone?.trim() ?? '',
    website: account?.website?.trim() ?? '',
    birthday: account?.birthday?.trim() ?? '',
  };
}

function changedFields(draft: CloudProfileFieldDraft, saved: CloudProfileFieldDraft): CloudProfileField[] {
  return CLOUD_PROFILE_FIELDS.filter((field) => draft[field].trim() !== saved[field]);
}

export function cloudProfileSaveInput({
  displayNameDraft,
  avatarMutationDraft,
  fieldDraft,
  savedFields,
}: {
  displayNameDraft: string;
  avatarMutationDraft: CanonicalAvatarMutation | null;
  fieldDraft?: CloudProfileFieldDraft;
  savedFields?: CloudProfileFieldDraft;
}): CloudProfileUpdateInput {
  const input: CloudProfileUpdateInput = { displayName: displayNameDraft.trim() };
  if (avatarMutationDraft) input.avatarMutation = avatarMutationDraft;
  if (fieldDraft && savedFields) {
    for (const field of changedFields(fieldDraft, savedFields)) input[field] = fieldDraft[field].trim();
  }
  return input;
}

export function cloudProfileIsDirty({
  account,
  displayNameDraft,
  avatarMutationDraft,
  fieldDraft,
}: {
  account: CloudAccount | null;
  displayNameDraft: string;
  avatarMutationDraft: CanonicalAvatarMutation | null;
  fieldDraft: CloudProfileFieldDraft;
}): boolean {
  return Boolean(avatarMutationDraft)
    || displayNameDraft.trim() !== (account?.displayName?.trim() ?? '')
    || changedFields(fieldDraft, cloudProfileFieldDraft(account)).length > 0;
}

export function cloudProfileErrorTarget(caught: unknown): CloudProfileErrorTarget {
  return caught instanceof CloudAuthError ? ERROR_FIELDS[caught.code] ?? 'form' : 'form';
}

export function localDateString(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type TimeZoneOption = { value: string; label: string };

function zoneName(timeZone: string, at: Date, style: 'longGeneric' | 'long' | 'shortOffset'): string {
  try {
    const options = { timeZone, timeZoneName: style } as Intl.DateTimeFormatOptions;
    return new Intl.DateTimeFormat('en-US', options).formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

function offsetMinutes(offset: string): number {
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(offset);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '-' ? -minutes : minutes;
}

/** "<name>, GMT±h" using standard (non-daylight) time, the smaller of the January and July offsets. */
function timeZoneParts(timeZone: string) {
  const year = new Date().getFullYear();
  const [winter, summer] = [new Date(Date.UTC(year, 0, 15)), new Date(Date.UTC(year, 6, 15))];
  const winterOffset = zoneName(timeZone, winter, 'shortOffset');
  const summerOffset = zoneName(timeZone, summer, 'shortOffset');
  const standardAt = offsetMinutes(summerOffset) < offsetMinutes(winterOffset) ? summer : winter;
  const offset = zoneName(timeZone, standardAt, 'shortOffset') || 'GMT';
  const name = zoneName(timeZone, standardAt, 'longGeneric') || zoneName(timeZone, standardAt, 'long') || timeZone;
  return { minutes: offsetMinutes(offset), label: `${name}, ${offset === 'GMT' ? 'GMT+0' : offset}` };
}

function cityName(timeZone: string): string {
  return (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
}

let cachedTimeZoneOptions: TimeZoneOption[] | null = null;

/** All IANA zones, labelled "<name>, GMT±h"; zones sharing a label also name their city. */
export function timeZoneOptions(): TimeZoneOption[] {
  if (cachedTimeZoneOptions) return cachedTimeZoneOptions;
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const zones = typeof supported === 'function' ? supported('timeZone') : [];
  const parts = zones.map((zone) => ({ zone, ...timeZoneParts(zone) }));
  const counts = new Map<string, number>();
  for (const part of parts) counts.set(part.label, (counts.get(part.label) ?? 0) + 1);
  cachedTimeZoneOptions = parts
    .map((part) => ({
      value: part.zone,
      minutes: part.minutes,
      label: (counts.get(part.label) ?? 0) > 1 ? `${part.label} (${cityName(part.zone)})` : part.label,
    }))
    .sort((left, right) => left.minutes - right.minutes || left.label.localeCompare(right.label))
    .map(({ value, label }) => ({ value, label }));
  return cachedTimeZoneOptions;
}

export function timeZoneOptionLabel(timeZone: string): string {
  return timeZoneOptions().find((option) => option.value === timeZone)?.label ?? timeZoneParts(timeZone).label;
}

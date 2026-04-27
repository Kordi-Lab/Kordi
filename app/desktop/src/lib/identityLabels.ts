const SELF_REFERENCE_RE = /^(you|me)$/i;
const FIRST_PERSON_POSSESSIVE_RE = /^(my|your)\s+/i;

function cleanLabel(value?: string | null) {
  return value?.trim() ?? '';
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capitalizeFirst(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function isSelfReferenceName(value?: string | null) {
  return SELF_REFERENCE_RE.test(cleanLabel(value));
}

export function selfDisplayName(value?: string | null, isSelf = false) {
  const label = cleanLabel(value);
  if (isSelf || isSelfReferenceName(label)) return 'Me';
  return label;
}

export function selfObjectLabel(value?: string | null, isSelf = false) {
  const label = cleanLabel(value);
  if (isSelf || isSelfReferenceName(label)) return 'me';
  return label;
}

export function stripSelfPossessivePrefix(value?: string | null, ownerName?: string | null) {
  let label = cleanLabel(value);
  if (!label) return label;

  const owner = cleanLabel(ownerName);
  if (owner) {
    label = label.replace(new RegExp(`^${escapeRegExp(owner)}['’]s\\s+`, 'i'), '');
  }
  label = label
    .replace(/^You['’]s\s+/i, '')
    .replace(/^Me['’]s\s+/i, '')
    .replace(FIRST_PERSON_POSSESSIVE_RE, '');
  return label.trim();
}

export function firstPersonPossessiveLabel(value?: string | null, ownerName?: string | null) {
  const label = cleanLabel(value);
  if (!label) return label;
  if (/^my\s+/i.test(label)) return label.replace(/^my/i, 'My');
  const unscoped = stripSelfPossessivePrefix(label, ownerName) || label.replace(/^your\s+/i, '').trim();
  return `My ${capitalizeFirst(unscoped)}`;
}

export function possessiveScopedLabel(ownerName: string | null | undefined, value: string | null | undefined, ownerIsSelf = false) {
  const label = cleanLabel(value);
  if (!label) return null;

  const owner = cleanLabel(ownerName);
  const shouldUseFirstPerson = ownerIsSelf || isSelfReferenceName(owner);
  if (shouldUseFirstPerson) return firstPersonPossessiveLabel(label, owner);
  if (!owner) return label;

  const ownerPrefix = `${owner}'s `;
  const ownerPrefixPattern = new RegExp(`^${escapeRegExp(owner)}['’]s\\s+`, 'i');
  const unscoped = label.replace(ownerPrefixPattern, '').trim();
  return ownerPrefixPattern.test(label) ? label : `${ownerPrefix}${unscoped || label}`;
}

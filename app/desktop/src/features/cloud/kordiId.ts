const KORDI_ID_DIGIT_COUNT = 9;
const KORDI_HANDLE_PATTERN = /^[A-Za-z0-9]{3,30}$/;

/** Returns the nine-digit number or the user-chosen handle (case preserved), else null. */
export function normalizeKordiId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;

  const withoutPrefix = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!withoutPrefix) return null;

  if (!/[^\d\s-]/.test(withoutPrefix)) {
    const digits = withoutPrefix.replace(/[^\d]/g, '');
    if (digits.length !== KORDI_ID_DIGIT_COUNT || digits.startsWith('0')) return null;
    return digits;
  }
  if (!KORDI_HANDLE_PATTERN.test(withoutPrefix) || !/[A-Za-z]/.test(withoutPrefix)) return null;
  return withoutPrefix;
}

export function formatKordiHandle(value: string | null | undefined): string | null {
  const normalized = normalizeKordiId(value);
  return normalized ? `@${normalized}` : null;
}

/** Handles are unique case-insensitively, so compare them that way. */
export function sameKordiId(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeKordiId(left);
  const b = normalizeKordiId(right);
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

const KORDI_ID_DIGIT_COUNT = 9;

export function normalizeKordiId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;

  const withoutPrefix = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!withoutPrefix || /[^\d\s-]/.test(withoutPrefix)) return null;

  const digits = withoutPrefix.replace(/[^\d]/g, '');
  if (digits.length !== KORDI_ID_DIGIT_COUNT || digits.startsWith('0')) return null;
  return digits;
}

export function formatKordiHandle(value: string | null | undefined): string | null {
  const normalized = normalizeKordiId(value);
  return normalized ? `@${normalized}` : null;
}

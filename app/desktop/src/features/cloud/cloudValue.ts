export function cloudObjectContent(
  value: unknown,
): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function cleanCloudText(value?: string | null) {
  return (value ?? '').trim();
}

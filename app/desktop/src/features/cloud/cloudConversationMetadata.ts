export function cleanCloudSessionId(value?: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
}

export function cleanCloudConversationTitle(value?: string | null): string | null {
  const title = value?.trim().replace(/\s+/g, ' ') ?? '';
  if (
    !title
    || /^(#\s*)?(my kordi|new session|untitled session)$/i.test(title)
  ) return null;
  return title;
}

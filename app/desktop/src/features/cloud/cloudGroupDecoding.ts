import type { DesktopChatMessageRoute } from '@/lib/desktop';

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function runtimeRoute(value: unknown): DesktopChatMessageRoute | null {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const model = cleanText(record.defaultModel) || cleanText(record.model);
  const authProvider = cleanText(record.defaultAuthProvider) || cleanText(record.authProvider);
  const authChoice = cleanText(record.defaultAuthChoice) || cleanText(record.authChoice);
  const thinking = cleanText(record.thinking);
  return model || thinking ? {
    ...(model ? { model } : {}),
    ...(authProvider ? { authProvider } : {}),
    ...(authChoice ? { authChoice } : {}),
    ...(thinking ? { thinking } : {}),
  } : null;
}

export function cloudGroupMessageRuntimeFields(candidate: Record<string, unknown>): {
  agentRuntimeRoute?: DesktopChatMessageRoute | null;
  messageKind?: string | null;
  structuredContent?: Record<string, unknown> | null;
} {
  const structuredContent = candidate.structuredContent;
  return {
    agentRuntimeRoute: runtimeRoute(candidate.agentRuntimeRoute),
    messageKind: cleanText(candidate.messageKind) || null,
    structuredContent: structuredContent && typeof structuredContent === 'object' && !Array.isArray(structuredContent)
      ? structuredContent as Record<string, unknown>
      : null,
  };
}

export function integerMilliseconds(
  value: unknown,
  fallback: number | null = null,
): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

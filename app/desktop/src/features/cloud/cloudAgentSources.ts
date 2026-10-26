import type { MessageEventSource } from '@/kordi-app/types/message';

/** At most this many source chips show under one agent message. */
export const CLOUD_AGENT_SOURCE_LIMIT = 8;
const TITLE_LIMIT = 60;

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit).trim() : '';
}

/**
 * The connector events an agent message is about (`sources` of an
 * agent-response envelope or of stored message content), in order. Malformed
 * entries and repeated events are dropped; the value is untrusted input.
 */
export function parseCloudAgentSources(value: unknown): MessageEventSource[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sources: MessageEventSource[] = [];
  for (const entry of value) {
    if (sources.length >= CLOUD_AGENT_SOURCE_LIMIT) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const eventId = text(record.eventId, 160);
    const provider = text(record.provider, 40).toLowerCase();
    const title = text(record.title, TITLE_LIMIT);
    if (!eventId || !provider || seen.has(eventId)) continue;
    seen.add(eventId);
    sources.push({ eventId, provider, title });
  }
  return sources;
}

/** `{ eventSources }` for a transcript message whose stored content names sources, else nothing. */
export function messageEventSourcesField(value: unknown): { eventSources?: MessageEventSource[] } {
  const eventSources = parseCloudAgentSources(value);
  return eventSources.length > 0 ? { eventSources } : {};
}

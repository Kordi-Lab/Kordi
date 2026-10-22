import type { DesktopChatToolSnapshot } from '@/kordi-app/types';

/** Ordered user-facing text and references to tool records, scoped to one turn. */
export type TurnSegment =
  | { id: string; kind: 'text'; text: string; revision?: number }
  | { id: string; kind: 'tool'; toolId: string };

export function parseTurnSegments(value: unknown): TurnSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const segments: TurnSegment[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
    if (item.kind === 'text' && typeof item.text === 'string') {
      segments.push({ id: item.id, kind: 'text', text: item.text,
        ...(typeof item.revision === 'number' && Number.isSafeInteger(item.revision) && item.revision >= 0 ? { revision: item.revision } : {}),
      });
    } else if (item.kind === 'tool' && typeof item.toolId === 'string' && item.toolId) {
      segments.push({ id: item.id, kind: 'tool', toolId: item.toolId });
    } else continue;
    seen.add(item.id);
  }
  return segments.length ? segments : undefined;
}

export function mergeTurnSegments(current?: TurnSegment[], next?: TurnSegment[]) {
  if (!next?.length) return current;
  if (!current?.length) return next;
  // Segment IDs establish identity; snapshots may arrive late while a run streams.
  const incoming = new Map(next.map(segment => [segment.id, segment]));
  const merged = current.map(segment => {
    const update = incoming.get(segment.id);
    incoming.delete(segment.id);
    if (segment.kind === 'text' && update?.kind === 'text' && segment.revision !== undefined && update.revision !== undefined && update.revision < segment.revision) return segment;
    return update ?? segment;
  });
  return [...merged, ...incoming.values()];
}

export type TurnContentGroup =
  | Extract<TurnSegment, { kind: 'text' }>
  | { id: string; kind: 'tools'; tools: DesktopChatToolSnapshot[]; unavailable: number };

export function groupTurnSegments(segments: TurnSegment[], tools: DesktopChatToolSnapshot[]): TurnContentGroup[] {
  const byId = new Map(tools.map(tool => [tool.id, tool]));
  const groups: TurnContentGroup[] = [];
  for (const segment of segments) {
    if (segment.kind === 'text') {
      // Thinking-only message starts do not create visible prose.
      if (segment.text.trim()) groups.push(segment);
      continue;
    }
    let group = groups[groups.length - 1];
    if (group?.kind !== 'tools') {
      group = { id: segment.id, kind: 'tools', tools: [], unavailable: 0 };
      groups.push(group);
    }
    const tool = byId.get(segment.toolId);
    if (tool) group.tools.push(tool);
    else group.unavailable += 1;
  }
  return groups;
}

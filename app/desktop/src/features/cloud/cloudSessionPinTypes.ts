import type { CloudPinHistoryEvent } from './cloudPinHistory';
import type { CloudSessionPinAction } from './chatSyncTypes';

export type CloudSessionPin = {
  sessionId: string;
  sharedMessageId: string | null;
  privateMessageId: string | null;
  sharedMessageIds?: string[];
  privateMessageIds?: string[];
  effectiveMessageId: string | null;
  updatedAt: string | null;
  history?: CloudPinHistoryEvent[];
  lastAction?: CloudSessionPinAction | null;
};

export const MAX_PINNED_MESSAGES = 5;

export function sessionPinMessageIds(pin: CloudSessionPin | null | undefined, scope: 'shared' | 'private'): string[] {
  const ids = scope === 'shared' ? pin?.sharedMessageIds : pin?.privateMessageIds;
  const legacyId = scope === 'shared' ? pin?.sharedMessageId : pin?.privateMessageId;
  return [...new Set((ids ?? (legacyId ? [legacyId] : [])).map(id => id.trim()).filter(Boolean))];
}

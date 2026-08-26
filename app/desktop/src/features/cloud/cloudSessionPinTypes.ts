import type { CloudSessionPinAction } from './chatSyncTypes';

export type CloudSessionPin = {
  sessionId: string;
  sharedMessageId: string | null;
  privateMessageId: string | null;
  effectiveMessageId: string | null;
  updatedAt: string | null;
  lastAction?: CloudSessionPinAction | null;
};

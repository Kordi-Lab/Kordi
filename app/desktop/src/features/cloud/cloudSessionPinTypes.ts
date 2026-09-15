import type { CloudPinHistoryEvent } from './cloudPinHistory';
import type { CloudSessionPinAction } from './chatSyncTypes';

export type CloudSessionPin = {
  sessionId: string;
  sharedMessageId: string | null;
  privateMessageId: string | null;
  effectiveMessageId: string | null;
  updatedAt: string | null;
  history?: CloudPinHistoryEvent[];
  lastAction?: CloudSessionPinAction | null;
};

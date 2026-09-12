import type { CanonicalSessionMessage } from '../types';

export type CanonicalTimelineCursor = Pick<CanonicalSessionMessage, 'id' | 'createdAtMs' | 'sequenceNum'>;

export type CanonicalMessagePage = {
  timelineOrder?: boolean;
  replaceWindow?: boolean;
  sessionId: string;
  messages: CanonicalSessionMessage[];
  oldestSequenceNum: number | null;
  newestSequenceNum: number | null;
  hasOlder: boolean;
};

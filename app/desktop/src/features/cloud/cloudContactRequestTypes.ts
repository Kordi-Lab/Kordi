import type { CloudContactSummary } from './cloudContactTypes';
import type { CloudMessage } from './cloudMessageTypes';

export type CloudContactRequestDirection = 'incoming' | 'outgoing';
export type CloudContactRequestStatus = 'pending' | 'accepted' | 'rejected';

export type CloudContactRequest = {
  requestId: string;
  fromAccountId: string;
  toAccountId: string;
  status: CloudContactRequestStatus;
  direction: CloudContactRequestDirection;
  message: string | null;
  createdAt: string;
  decidedAt: string | null;
  counterpart: CloudContactSummary | null;
};

export type CloudContactAcceptResult = {
  request: CloudContactRequest;
  helloMessage?: CloudMessage | null;
};

import type { MutableRefObject } from 'react';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudAuthClient, CloudMessage } from './authClient';
import type { CloudMessageIndex } from './cloudMessageIndex';
import type { CloudGroupOutbox, CloudGroupOutboxEntry } from './cloudGroupOutbox';

export type CloudGroupControlTransport = {
  client: CloudAuthClient;
  messageIndex: CloudMessageIndex;
  outbox: CloudGroupOutbox | null;
  mergeMessage: (message: CloudMessage) => void;
  persistOutboxDelivery: (entry: CloudGroupOutboxEntry) => Promise<void>;
  claimFreshFallback: (
    sentMessages: readonly CloudMessage[],
    requestMessageId: string,
    token: string,
  ) => Promise<void>;
  syncDiff: () => Promise<void>;
};

export type CloudGroupControlCanonicalContext = {
  state: CanonicalSessionState | null | undefined;
  stateRef: MutableRefObject<CanonicalSessionState | null>;
  titleBackfillsRef: MutableRefObject<Set<string>>;
  initialMessagesSettled: boolean;
};

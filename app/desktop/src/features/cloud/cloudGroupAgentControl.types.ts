import type { DesktopChatContextMessage } from '@/lib/desktop';
import type {
  CanonicalIdentity,
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import type { CloudMessage } from './authClient';
import type { HandleCloudGroupAgentFailureInput } from './cloudGroupAgentFailure';
import type {
  CanonicalSessionStateSetter,
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from './cloudGroupControlContext';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import type {
  CloudActivityParticipantProfile,
  CloudSessionActivityStore,
} from './cloudSessionActivity';

export type CloudGroupAgentStateOps =
  HandleCloudGroupAgentFailureInput['stateOps'] & {
    upsertIdentity(
      current: CanonicalSessionState | null,
      identity: CanonicalIdentity,
    ): CanonicalSessionState | null;
    removePendingRows(
      current: CanonicalSessionState | null,
      requestId: string,
      targetAccountId: string,
    ): CanonicalSessionState | null;
    removeTimeoutPlaceholder(
      current: CanonicalSessionState | null,
      noticeId: string,
    ): CanonicalSessionState | null;
  };

export type CloudGroupAgentPolicy = {
  isRecentMention(createdAt: string): boolean;
  messageTargetsLocalAgent(
    message: NonNullable<CloudGroupMessageControlContext['envelope']['message']>,
    account: CloudGroupMessageControlContext['account'],
    participants: CloudGroupMessageControlContext['envelope']['participants'],
  ): boolean;
  responseExists(input: {
    localAccountId: string;
    requestMessageId: string;
    messages?: readonly CloudMessage[];
    groupRows?: readonly IndexedCloudGroupRow[];
    ignoreFailedCloudFallback?: boolean;
  }): boolean;
  fallbackRunOwnsRequest(input: {
    client: CloudGroupAgentRuntime['client'];
    token: string;
    requestMessageId: string;
  }): Promise<boolean>;
  nativeContext(input: {
    groupRows: readonly IndexedCloudGroupRow[];
    groupId: string;
    requestMessageId: string;
    requestCreatedAtMs: number;
    respondingAccountId: string;
    respondingAgentId?: string | null;
  }): DesktopChatContextMessage[];
  waitForTurn(
    turnId: string,
    onSnapshot?: (snapshot: DesktopChatTurnSnapshot) => void,
  ): Promise<DesktopChatTurnSnapshot>;
  publishActivity(input: {
    client: CloudGroupAgentRuntime['client'];
    token: string;
    accountId: string;
    sessionId: string;
    participantAccountIds: string[];
    participantProfiles?: CloudActivityParticipantProfile[];
    turn: DesktopChatTurnSnapshot;
    mergeActivity(snapshot: CloudSessionActivityStore): void;
  }): Promise<void>;
};

export type ApplyCloudGroupAgentControlInput = {
  context: CloudGroupMessageControlContext;
  setCanonicalState: CanonicalSessionStateSetter;
  runtime: CloudGroupAgentRuntime;
  stateOps: CloudGroupAgentStateOps;
  policy: CloudGroupAgentPolicy;
};

export type CloudGroupAgentPresentation = {
  agentId: string;
  identityId: string;
  displayName: string;
  ownerDisplayName: string;
};

import type { Dispatch, SetStateAction } from 'react';
import type {
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
  MessageAttachment,
} from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  CloudPublicProfile,
} from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import type { CloudGroupControlEnvelope, CloudGroupParticipant } from './cloudGroupMessages';
import type { CloudMessageIndex } from './cloudMessageIndex';
import type { CloudSessionActivityStore } from './cloudSessionActivity';

export type CanonicalSessionStateSetter = Dispatch<SetStateAction<CanonicalSessionState | null>>;

export type CloudGroupControlContext = {
  account: CloudAccount;
  cloudMessage: CloudMessage;
  envelope: CloudGroupControlEnvelope;
  canonicalState: CanonicalSessionState;
  nextState: CanonicalSessionState;
  localHumanIdentityId: string;
  groupSpaceId: string;
  participantByAccount: Map<string, CloudGroupParticipant>;
  identityIdByAccount: Map<string, string>;
};

export type CloudGroupMessageControlContext = CloudGroupControlContext & {
  senderIsAgent: boolean;
  mappedAttachments: MessageAttachment[];
};

export type CloudGroupSessionRuntime = {
  account: CloudAccount | null;
  client: CloudAuthClient;
  profileCache: Map<string, CloudPublicProfile>;
};

export type CloudGroupCanonicalRuntime = {
  getState(): CanonicalSessionState | null;
  setState?: CanonicalSessionStateSetter;
};

export type CloudGroupAgentRuntime = {
  client: CloudAuthClient;
  messageIndex(): CloudMessageIndex;
  sessionActivity(): CloudSessionActivityStore;
  setSessionActivity: Dispatch<SetStateAction<CloudSessionActivityStore>>;
  setLocalTurns: Dispatch<SetStateAction<Record<string, DesktopChatTurnSnapshot>>>;
  processedMentionIds: Set<string>;
  turnIdsByRequestId: Map<string, string>;
  agentDefinitionsById: Record<string, CloudAgentDefinition>;
  routesBySessionId?: Record<string, DesktopChatMessageRoute>;
  defaultRoute?: DesktopChatMessageRoute | null;
  mergeMessage(message: CloudMessage): void;
  syncDiff(): Promise<void>;
  reportFailure(kind: 'local-response' | 'no-provider-notice', error: unknown): void;
};

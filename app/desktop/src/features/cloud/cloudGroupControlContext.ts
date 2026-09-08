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
import type { CloudAgentTurnCoordinator } from './cloudAgentTurnCoordinator';
import type { CloudGroupControlEnvelope, CloudGroupParticipant } from './cloudGroupMessages';
import type { CloudMessageIndex } from './cloudMessageIndex';
import type { CloudSessionActivityStore } from './cloudSessionActivity';

// Async group work must publish operations against the latest state, never a
// captured whole-state snapshot whose missing rows could mean either stale or deleted.
export type CanonicalSessionStateUpdate = (current: CanonicalSessionState | null) => CanonicalSessionState | null;
export type CanonicalSessionStateSetter = (update: CanonicalSessionStateUpdate) => void;

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

export type CloudGroupSessionPreparation = {
  signature: string;
  localHumanIdentityId: string;
  groupSpaceId: string;
  participantByAccount: Map<string, CloudGroupParticipant>;
  identityIdByAccount: Map<string, string>;
};

export type CloudGroupSessionPreparationCache = Map<
  string,
  CloudGroupSessionPreparation
>;

export type CloudGroupSessionRuntime = {
  account: CloudAccount | null;
  client: CloudAuthClient;
  profileCache: Map<string, CloudPublicProfile>;
  sessionPreparationCache: CloudGroupSessionPreparationCache;
};

export type CloudGroupCanonicalRuntime = {
  getState(): CanonicalSessionState | null;
  setState?: CanonicalSessionStateSetter;
};

export type CloudGroupAgentRuntime = {
  ready?: boolean;
  client: CloudAuthClient;
  turnCoordinator: CloudAgentTurnCoordinator;
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

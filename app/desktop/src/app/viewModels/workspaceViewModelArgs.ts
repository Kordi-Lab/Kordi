import type { SessionHydrationState } from '@/features/canonical/canonicalStore';
import type { CloudAgentDefinition } from '@/features/cloud/cloudAgents';
import type { CloudSessionActivityStore } from '@/features/cloud/cloudSessionActivity';
import type { CloudPresenceStore } from '@/features/cloud/presence';
import type {
  CanonicalSessionState,
  CanonicalSessionSummary,
  Conversation,
  DesktopChatMessage,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  DesktopCollaborationState,
  Message,
  NavId,
  Project,
} from '@/kordi-app/types';

export type UseWorkspaceViewModelsArgs = {
  cloudAccountId?: string;
  cloudCatalogReady?: boolean;
  isNativeShell: boolean;
  isDesktopChatLoading: boolean;
  desktopChatState: DesktopChatState | null; localAgentDisplayName?: string | null;
  desktopCollaborationState: DesktopCollaborationState | null;
  canonicalSessionState: CanonicalSessionState | null;
  canonicalSessionSummaries?: CanonicalSessionSummary[];
  transcriptHydration?: Readonly<Record<string, SessionHydrationState>>;
  hiddenSessionIds: Set<string>;
  archivedSessionIds?: ReadonlySet<string>;
  projectWorkspaces: Project[];
  projectSelectedSessionIds: Record<string, string>;
  activeNav: NavId;
  activeConvId: string;
  activeProjectId: string;
  activeProjectSessionId: string;
  chatSearch: string;
  projectSearch: string;
  contactSearch: string;
  activeContactId: string;
  activeAgentId: string;
  cachedChatSessionMessages: Record<string, Message[]>;
  cachedProjectSessionMessages: Record<string, Message[]>;
  cachedDesktopSessionSourceMessages?: Record<string, DesktopChatMessage[]>;
  hydratedDesktopSessionIds?: ReadonlySet<string>;
  localSessionUnreadCounts: Record<string, number>;
  desktopLiveTurnsBySession: Record<string, DesktopChatTurnSnapshot>;
  mapDesktopMessages: (sessionId: string, messages: DesktopChatMessage[], sessionContext?: { metadata?: unknown }) => Message[];
  cloudSessionActivity?: CloudSessionActivityStore;
  cloudAgentDefinitionsById?: Record<string, CloudAgentDefinition>;
  cloudPresence?: CloudPresenceStore;
  cloudUnreadReady?: boolean; pendingGroupProjectionSessionIds?: ReadonlySet<string>;
  cloudLegacyGroupSessionTitlesById?: ReadonlyMap<string, string>; cloudReliableGroupSessionTitleIds?: ReadonlySet<string>; cloudReliableGroupSessionActivityAtMs?: ReadonlyMap<string, number>;
  transientChatConversations?: Conversation[];
};

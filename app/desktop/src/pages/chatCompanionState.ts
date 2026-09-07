import type { Conversation } from '@/kordi-app/types';

export type ComposerSelector = {
  scope: 'chat' | 'project';
  type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking';
};

export type CompanionSessionState = {
  pageConversationId: string;
  subsessionId: string | null;
  selectedConversationId: string | null;
  openConversationId: string | null;
  requestedConversationId: string | null;
  referenceContext: string | null;
  actionsOpen: boolean;
  sessionListOpen: boolean;
  openComposerSelector: ComposerSelector | null;
  drafts: Record<string, string>;
  createdConversation: Conversation | null;
  isCreating: boolean;
  creationError: string | null;
};

export function emptyState(pageConversationId: string): CompanionSessionState {
  return {
    pageConversationId,
    subsessionId: null,
    selectedConversationId: null,
    openConversationId: null,
    requestedConversationId: null,
    referenceContext: null,
    actionsOpen: false,
    sessionListOpen: false,
    openComposerSelector: null,
    drafts: {},
    createdConversation: null,
    isCreating: false,
    creationError: null,
  };
}

export function normalizeStateForCandidates(
  state: CompanionSessionState,
  pageConversationId: string,
  candidateIds: ReadonlySet<string>,
): CompanionSessionState {
  if (state.pageConversationId !== pageConversationId) {
    return emptyState(pageConversationId);
  }
  const selectedConversationId = state.selectedConversationId
    && (candidateIds.has(state.selectedConversationId) || state.createdConversation?.id === state.selectedConversationId)
    ? state.selectedConversationId
    : null;
  const requestedConversationId = state.requestedConversationId
    && !candidateIds.has(state.requestedConversationId)
    ? state.requestedConversationId
    : null;
  const resolvedRequestedConversationId = state.requestedConversationId
    && candidateIds.has(state.requestedConversationId)
    ? state.requestedConversationId
    : null;
  const openConversationId = resolvedRequestedConversationId ?? (state.openConversationId
    && (candidateIds.has(state.openConversationId) || state.createdConversation?.id === state.openConversationId)
    ? state.openConversationId
    : null);
  if (
    (resolvedRequestedConversationId ?? selectedConversationId) === state.selectedConversationId
    && openConversationId === state.openConversationId
    && requestedConversationId === state.requestedConversationId
    && !(state.createdConversation && candidateIds.has(state.createdConversation.id))
  ) {
    return state;
  }
  return {
    ...state,
    selectedConversationId: resolvedRequestedConversationId ?? selectedConversationId,
    openConversationId,
    requestedConversationId,
    createdConversation: state.createdConversation && !candidateIds.has(state.createdConversation.id) ? state.createdConversation : null,
    referenceContext: openConversationId ? state.referenceContext : null,
    actionsOpen: openConversationId ? state.actionsOpen : false,
    sessionListOpen: openConversationId ? state.sessionListOpen : false,
    openComposerSelector: openConversationId
      ? state.openComposerSelector
      : null,
  };
}

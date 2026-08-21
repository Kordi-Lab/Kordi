import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { Conversation } from '@/kordi-app/types';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import type {
  ChatsPageComposer,
  ChatsPageRuntime,
} from '@/pages/chatsPage.types';
import {
  buildAskAgentSessionReferenceContext,
  buildAskAgentSessionReferenceContextMessage,
  chatCompanionCandidates,
  chatCompanionSessionOptions,
  chatSideAgentConversationForOpenRequest,
  pairedCompanionConversation,
} from '@/pages/chatsPage.model';
import { scheduleTranscriptScrollToBottom } from '@/pages/chatsPage.header';

type ComposerSelector = {
  scope: 'chat' | 'project';
  type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking';
};

type CompanionSessionState = {
  pageConversationId: string;
  selectedConversationId: string | null;
  openConversationId: string | null;
  referenceContext: string | null;
  actionsOpen: boolean;
  sessionListOpen: boolean;
  openComposerSelector: ComposerSelector | null;
  drafts: Record<string, string>;
};

type UseChatCompanionSessionInput = {
  activeConversation: Conversation;
  conversations: Conversation[];
  directConversations?: Conversation[];
  activePaneKind: 'human' | 'agent' | null;
  attachmentCount: number;
  setComposerTextForSession: ChatsPageComposer['setChatComposerTextForSession'];
  onSendChatMessage: ChatsPageRuntime['onSendChatMessage'];
  onCreateAgentSession: ChatsPageRuntime['onCreateAgentSession'];
  onPrefetchChatSession: ChatsPageRuntime['onPrefetchChatSession'];
};

function emptyState(pageConversationId: string): CompanionSessionState {
  return {
    pageConversationId,
    selectedConversationId: null,
    openConversationId: null,
    referenceContext: null,
    actionsOpen: false,
    sessionListOpen: false,
    openComposerSelector: null,
    drafts: {},
  };
}

function normalizeStateForCandidates(
  state: CompanionSessionState,
  pageConversationId: string,
  candidateIds: ReadonlySet<string>,
): CompanionSessionState {
  if (state.pageConversationId !== pageConversationId) {
    return emptyState(pageConversationId);
  }
  const selectedConversationId = state.selectedConversationId
    && candidateIds.has(state.selectedConversationId)
    ? state.selectedConversationId
    : null;
  const openConversationId = state.openConversationId
    && candidateIds.has(state.openConversationId)
    ? state.openConversationId
    : null;
  if (
    selectedConversationId === state.selectedConversationId
    && openConversationId === state.openConversationId
  ) {
    return state;
  }
  return {
    ...state,
    selectedConversationId,
    openConversationId,
    referenceContext: openConversationId ? state.referenceContext : null,
    actionsOpen: openConversationId ? state.actionsOpen : false,
    sessionListOpen: openConversationId ? state.sessionListOpen : false,
    openComposerSelector: openConversationId
      ? state.openComposerSelector
      : null,
  };
}

export function useChatCompanionSession({
  activeConversation,
  conversations,
  directConversations = conversations,
  activePaneKind,
  attachmentCount,
  setComposerTextForSession,
  onSendChatMessage,
  onCreateAgentSession,
  onPrefetchChatSession,
}: UseChatCompanionSessionInput) {
  const visibleCandidates = useMemo(
    () => chatCompanionCandidates(activeConversation, conversations),
    [activeConversation, conversations],
  );
  const candidates = useMemo(
    () => chatCompanionCandidates(activeConversation, directConversations),
    [activeConversation, directConversations],
  );
  const sessionOptions = useMemo(
    () => chatCompanionSessionOptions(activeConversation, conversations),
    [activeConversation, conversations],
  );
  const selectableSessionIds = useMemo(
    () => new Set(
      sessionOptions
        .filter((option) => option.selectable)
        .map((option) => option.conversation.id),
    ),
    [sessionOptions],
  );
  const candidateIds = useMemo(
    () => new Set(candidates.map((conversation) => conversation.id)),
    [candidates],
  );
  const candidateKey = useMemo(
    () => JSON.stringify([...candidateIds].sort()),
    [candidateIds],
  );
  const [storedState, setStoredState] = useState<CompanionSessionState>(
    () => emptyState(activeConversation.id),
  );
  const [transcriptLoadFailureSessionId, setTranscriptLoadFailureSessionId] = useState<string | null>(null);
  const [transcriptLoadAttempt, setTranscriptLoadAttempt] = useState(0);
  const [trackedCandidateKey, setTrackedCandidateKey] = useState(candidateKey);
  const state = normalizeStateForCandidates(
    storedState,
    activeConversation.id,
    candidateIds,
  );
  if (
    state !== storedState
    || trackedCandidateKey !== candidateKey
  ) {
    setStoredState(state);
    setTrackedCandidateKey(candidateKey);
  }
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const selectedConversation = candidates.find(
    (conversation) => conversation.id === state.selectedConversationId,
  ) ?? null;
  const suggestedConversation = pairedCompanionConversation(
    activeConversation,
    visibleCandidates,
  ) ?? visibleCandidates[0] ?? null;
  const suggested = selectedConversation ?? suggestedConversation;
  const conversation = chatSideAgentConversationForOpenRequest(
    state.openConversationId,
    candidates,
  );
  const conversationId = conversation?.id ?? null;
  const transcriptNeedsLoading = Boolean(
    conversation?.desktopRuntimeBacked
      && conversation.desktopRuntimeTranscriptLoaded !== true
      && !isLocalDraftChatConversationId(conversation.id),
  );
  const draftText = conversation ? state.drafts[conversation.id] ?? '' : '';

  useEffect(() => {
    if (!conversationId || !transcriptNeedsLoading || !onPrefetchChatSession) return;
    let cancelled = false;
    void onPrefetchChatSession(conversationId).then((loaded) => {
      if (!cancelled && !loaded) setTranscriptLoadFailureSessionId(conversationId);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, onPrefetchChatSession, transcriptLoadAttempt, transcriptNeedsLoading]);

  const updateState = (
    update: (current: CompanionSessionState) => CompanionSessionState,
  ) => {
    setStoredState((current) => update(normalizeStateForCandidates(
      current,
      activeConversation.id,
      candidateIds,
    )));
  };
  const updateDraft = (
    conversationId: string,
    value: string,
    target?: HTMLTextAreaElement,
  ) => {
    updateState((current) => ({
      ...current,
      drafts: { ...current.drafts, [conversationId]: value },
    }));
    setComposerTextForSession(conversationId, value);
    if (!target) return;
    target.style.height = '0px';
    target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
  };
  const activate = (conversationId: string, initialPrompt = '') => {
    setTranscriptLoadFailureSessionId((current) => (
      current === conversationId ? null : current
    ));
    updateState((current) => ({
      ...current,
      selectedConversationId: conversationId,
      openConversationId: conversationId,
      referenceContext: buildAskAgentSessionReferenceContext(activeConversation),
      actionsOpen: false,
      sessionListOpen: false,
      openComposerSelector: null,
      drafts: initialPrompt.trim()
        ? { ...current.drafts, [conversationId]: initialPrompt.trim() }
        : current.drafts,
    }));
    if (initialPrompt.trim()) {
      setComposerTextForSession(conversationId, initialPrompt.trim());
    }
  };
  const create = async (initialPrompt = '') => {
    if (!onCreateAgentSession) return false;
    const conversationId = await onCreateAgentSession();
    if (!conversationId) return false;
    activate(conversationId, initialPrompt);
    return true;
  };
  const open = async (initialPrompt = '') => {
    if (activePaneKind === 'agent' && onCreateAgentSession) {
      return create(initialPrompt);
    }
    if (!suggested) return create(initialPrompt);
    activate(suggested.id, initialPrompt);
    return true;
  };
  const sendDraft = (targetConversation: Conversation) => {
    const draft = state.drafts[targetConversation.id] ?? '';
    if (!draft.trim() && attachmentCount === 0) return;
    const referenceMessage = state.referenceContext
      ? buildAskAgentSessionReferenceContextMessage(
          activeConversation,
          state.referenceContext,
        )
      : null;
    void onSendChatMessage(
      draft,
      targetConversation.id,
      referenceMessage ? [referenceMessage] : [],
    );
    scheduleTranscriptScrollToBottom(transcriptScrollRef);
    updateState((current) => {
      const drafts = { ...current.drafts };
      delete drafts[targetConversation.id];
      return { ...current, drafts };
    });
  };
  const setOpenComposerSelector: Dispatch<
    SetStateAction<ComposerSelector | null>
  > = (next) => updateState((current) => ({
    ...current,
    openComposerSelector: typeof next === 'function'
      ? next(current.openComposerSelector)
      : next,
  }));

  return {
    conversation,
    candidates,
    sessionOptions,
    suggested,
    draftText,
    canOpen: Boolean(suggested || onCreateAgentSession),
    transcript: {
      isLoading: transcriptNeedsLoading
        && transcriptLoadFailureSessionId !== conversationId,
      loadError: transcriptNeedsLoading
        && transcriptLoadFailureSessionId === conversationId
        ? 'Couldn’t load chat history.'
        : null,
      retry: () => {
        setTranscriptLoadFailureSessionId((current) => (
          current === conversationId ? null : current
        ));
        setTranscriptLoadAttempt((current) => current + 1);
      },
    },
    refs: {
      transcriptScroll: transcriptScrollRef,
      attachmentInput: attachmentInputRef,
    },
    menu: {
      actionsOpen: conversation ? state.actionsOpen : false,
      sessionListOpen: conversation ? state.sessionListOpen : false,
      canCreateSession: Boolean(onCreateAgentSession),
      toggleActions: () => updateState((current) => ({
        ...current,
        actionsOpen: !current.actionsOpen,
        sessionListOpen: false,
      })),
      closeActions: () => updateState((current) => (
        !current.actionsOpen && !current.sessionListOpen
          ? current
          : {
              ...current,
              actionsOpen: false,
              sessionListOpen: false,
            }
      )),
      closeSessionList: () => updateState((current) => ({
        ...current,
        sessionListOpen: false,
      })),
      openSessionList: () => updateState((current) => ({
        ...current,
        sessionListOpen: true,
      })),
    },
    selector: {
      value: state.openComposerSelector,
      set: setOpenComposerSelector,
      toggle: (scope: ComposerSelector['scope'], type: ComposerSelector['type']) => (
        updateState((current) => ({
          ...current,
          openComposerSelector:
            current.openComposerSelector?.scope === scope
              && current.openComposerSelector.type === type
              ? null
              : { scope, type },
        }))
      ),
    },
    actions: {
      create,
      open,
      switchConversation: (conversationId: string) => {
        if (
          !selectableSessionIds.has(conversationId)
          && !candidateIds.has(conversationId)
        ) return;
        activate(conversationId);
      },
      close: () => updateState((current) => ({
        ...current,
        selectedConversationId: null,
        openConversationId: null,
        referenceContext: null,
        actionsOpen: false,
        sessionListOpen: false,
        openComposerSelector: null,
      })),
      updateDraft,
      sendDraft,
    },
  };
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { Conversation, MessageMention } from '@/kordi-app/types';
import { CloudAuthClient } from '@/features/cloud/authClient';
import { CLOUD_SESSION_CHANGED_EVENT, loadSession } from '@/features/cloud/session';
import { useAgentSubsession } from '@/features/cloud/useAgentSubsession';
import { subsessionConversation, subsessionMentionOptions } from '@/features/cloud/subsessionConversation';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import type {
  ChatAttachment,
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
  isPrivateOwnedAgentConversation,
} from '@/pages/chatsPage.model';
import { scheduleTranscriptScrollToBottom } from '@/pages/chatsPage.header';

type ComposerSelector = {
  scope: 'chat' | 'project';
  type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking';
};

type CompanionSessionState = {
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
};

type UseChatCompanionSessionInput = {
  activeConversation: Conversation;
  conversations: Conversation[];
  directConversations?: Conversation[];
  activePaneKind: 'human' | 'agent' | null;
  setComposerTextForSession: ChatsPageComposer['setChatComposerTextForSession'];
  onSendChatMessage: ChatsPageRuntime['onSendChatMessage'];
  onCreateAgentSession: ChatsPageRuntime['onCreateAgentSession'];
  onPrefetchChatSession: ChatsPageRuntime['onPrefetchChatSession'];
};

function emptyState(pageConversationId: string): CompanionSessionState {
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
  const requestedConversationId = state.requestedConversationId
    && !candidateIds.has(state.requestedConversationId)
    ? state.requestedConversationId
    : null;
  const resolvedRequestedConversationId = state.requestedConversationId
    && candidateIds.has(state.requestedConversationId)
    ? state.requestedConversationId
    : null;
  const openConversationId = resolvedRequestedConversationId ?? (state.openConversationId
    && candidateIds.has(state.openConversationId)
    ? state.openConversationId
    : null);
  if (
    (resolvedRequestedConversationId ?? selectedConversationId) === state.selectedConversationId
    && openConversationId === state.openConversationId
    && requestedConversationId === state.requestedConversationId
  ) {
    return state;
  }
  return {
    ...state,
    selectedConversationId: resolvedRequestedConversationId ?? selectedConversationId,
    openConversationId,
    requestedConversationId,
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
  const subsession = useAgentSubsession(state.subsessionId, true);
  const resourceConversation = useMemo(
    () => state.subsessionId ? subsessionConversation(state.subsessionId, subsession.snapshot, subsession.accountId) : null,
    [state.subsessionId, subsession.snapshot, subsession.accountId],
  );
  const [subsessionSending, setSubsessionSending] = useState(false);
  const sendingRef = useRef(false);
  const [subsessionSendError, setSubsessionSendError] = useState<{ id: string; message: string } | null>(null);
  const sendAttempts = useRef(new Map<string, { id: string; text: string; mentions: MessageMention[] }>());
  useEffect(() => {
    const reset = () => { setStoredState(emptyState(activeConversation.id)); sendAttempts.current.clear(); setSubsessionSendError(null); };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, reset);
    return () => window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, reset);
  }, [activeConversation.id]);
  const selectedConversation = candidates.find(
    (conversation) => conversation.id === state.selectedConversationId,
  ) ?? null;
  const suggestedConversation = pairedCompanionConversation(
    activeConversation,
    visibleCandidates,
  ) ?? visibleCandidates[0] ?? null;
  const suggested = selectedConversation ?? suggestedConversation;
  const conversation = resourceConversation ?? chatSideAgentConversationForOpenRequest(
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
    target?: HTMLTextAreaElement | HTMLDivElement,
  ) => {
    updateState((current) => ({
      ...current,
      drafts: { ...current.drafts, [conversationId]: value },
    }));
    if (conversationId !== state.subsessionId) setComposerTextForSession(conversationId, value);
    if (!target || target.tagName !== 'TEXTAREA') return;
    target.style.height = '0px';
    target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
  };
  const activate = (conversationId: string, initialPrompt = '') => {
    setTranscriptLoadFailureSessionId((current) => (
      current === conversationId ? null : current
    ));
    updateState((current) => ({
      ...current,
      subsessionId: null,
      selectedConversationId: conversationId,
      openConversationId: conversationId,
      requestedConversationId: null,
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
  const sendDraft = (
    targetConversation: Conversation,
    attachments: ChatAttachment[],
    mentions: MessageMention[] = [],
  ) => {
    const draft = state.drafts[targetConversation.id] ?? '';
    if (!draft.trim() && attachments.length === 0) return false;
    if (targetConversation.agentSubsessionId) {
      if (sendingRef.current || !subsession.snapshot || subsession.error) return false;
      if (attachments.length) { setSubsessionSendError({ id: targetConversation.id, message: 'This session supports text messages.' }); return false; }
      const id = targetConversation.agentSubsessionId;
      const text = draft.trim();
      const previous = sendAttempts.current.get(id);
      const attempt = previous?.text === text ? previous : { id: crypto.randomUUID(), text, mentions };
      sendAttempts.current.set(id, attempt);
      sendingRef.current = true; setSubsessionSending(true); setSubsessionSendError(null);
      void (async () => {
        try {
          const account = await loadSession();
          if (!account || account.accountId !== subsession.accountId) throw Error('Account changed');
          await new CloudAuthClient().sendAgentSubsessionMessage(account.token, id, attempt.id, text, attempt.mentions);
          if ((await loadSession())?.accountId !== account.accountId) return;
          sendAttempts.current.delete(id);
          setStoredState(current => ({
            ...current, drafts: current.drafts[id]?.trim() === text ? { ...current.drafts, [id]: '' } : current.drafts,
          }));
          subsession.reload();
          scheduleTranscriptScrollToBottom(transcriptScrollRef);
        } catch { setSubsessionSendError({ id, message: 'Could not send. Your message is kept below; try again.' }); }
        finally { sendingRef.current = false; setSubsessionSending(false); }
      })();
      return false;
    }
    // A side-pane location never makes a shared or external session private.
    if (!isPrivateOwnedAgentConversation(targetConversation) || targetConversation.id !== state.openConversationId) return false;
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
      attachments,
    );
    scheduleTranscriptScrollToBottom(transcriptScrollRef);
    updateState((current) => {
      const drafts = { ...current.drafts };
      delete drafts[targetConversation.id];
      return { ...current, drafts };
    });
    return true;
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
    subsession: state.subsessionId ? {
      mentionOptions: subsession.snapshot ? subsessionMentionOptions(subsession.snapshot, subsession.accountId) : [],
      sending: subsessionSending,
      sendError: subsessionSendError?.id === state.subsessionId ? subsessionSendError.message : null,
      disabled: !subsession.snapshot || Boolean(subsession.error),
    } : undefined,
    canOpen: Boolean(suggested || onCreateAgentSession),
    transcript: {
      isLoading: state.subsessionId ? !subsession.snapshot && !subsession.error : transcriptNeedsLoading
        && transcriptLoadFailureSessionId !== conversationId,
      loadError: state.subsessionId ? subsession.error : transcriptNeedsLoading
        && transcriptLoadFailureSessionId === conversationId
        ? 'Couldn’t load chat history.'
        : null,
      retry: () => {
        if (state.subsessionId) { subsession.reload(); return; }
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
      openSubsession: (subsessionId: string) => {
        setSubsessionSendError(null);
        updateState(current => ({ ...current, subsessionId, openConversationId: null, requestedConversationId: null,
          referenceContext: null, actionsOpen: false, sessionListOpen: false, openComposerSelector: null }));
      },
      switchConversation: (conversationId: string) => {
        const known = directConversations.find(item => item.id === conversationId);
        if (known && !isPrivateOwnedAgentConversation(known)) return;
        if (
          !selectableSessionIds.has(conversationId)
          && !candidateIds.has(conversationId)
        ) {
          if (!onPrefetchChatSession) return;
          updateState((current) => ({
            ...current,
            subsessionId: null,
            requestedConversationId: conversationId,
            referenceContext: buildAskAgentSessionReferenceContext(activeConversation),
          }));
          void onPrefetchChatSession(conversationId).then((loaded) => {
            if (!loaded) {
              updateState((current) => current.requestedConversationId === conversationId
                ? { ...current, requestedConversationId: null }
                : current);
            }
          });
          return;
        }
        activate(conversationId);
      },
      close: () => updateState((current) => ({
        ...current,
        subsessionId: null,
        selectedConversationId: null,
        openConversationId: null,
        requestedConversationId: null,
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

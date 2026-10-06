import type { Conversation, NavId } from '@/kordi-app/types';
import { spaceKindForConversation } from './participantSpaces';
import { isLocalDraftChatConversationId, LOCAL_DRAFT_CHAT_CONVERSATION_ID } from './draftSessions';

export type ChatNavId = 'chats' | 'agent-chats';

export function isChatNavigation(nav: string): nav is ChatNavId {
  return nav === 'chats' || nav === 'agent-chats';
}

export function chatNavigationForConversation(conversation?: Conversation): ChatNavId {
  if (!conversation) return 'chats';
  const kind = spaceKindForConversation(conversation);
  return kind === 'direct-human' || kind === 'group' ? 'chats' : 'agent-chats';
}

export function chatNavigationIndex(conversations: readonly Conversation[]) {
  const index = new Map<string, ChatNavId>();
  for (const conversation of conversations) {
    const destination = chatNavigationForConversation(conversation);
    index.set(conversation.id, destination);
    if (conversation.canonicalSessionId) index.set(conversation.canonicalSessionId, destination);
  }
  return index;
}

export function conversationIdAfterRemoval(
  conversations: readonly Conversation[],
  removedId: string,
  fallbackId: string,
): string {
  const removed = conversations.find(conversation => conversation.id === removedId || conversation.canonicalSessionId === removedId);
  if (!removed) return fallbackId;
  const destination = chatNavigationForConversation(removed);
  return conversations.find(conversation => (
    conversation.id !== removedId
    && conversation.canonicalSessionId !== removedId
    && chatNavigationForConversation(conversation) === destination
  ))?.id ?? (destination === 'agent-chats' ? LOCAL_DRAFT_CHAT_CONVERSATION_ID : '');
}

export type ChatNavigationState = {
  activeNav: NavId;
  activeConvId: string;
  selections: Record<ChatNavId, string>;
};

function destinationForId(id: string, index: ReadonlyMap<string, ChatNavId>) {
  return isLocalDraftChatConversationId(id) ? 'agent-chats' : index.get(id);
}

export function selectChatNavigation(state: ChatNavigationState, nav: NavId, index: ReadonlyMap<string, ChatNavId>): ChatNavigationState {
  if (nav === state.activeNav) return state;
  if (!isChatNavigation(nav)) return { ...state, activeNav: nav };
  const previous = state.selections[nav];
  const activeConvId = previous && (!index.has(previous) || destinationForId(previous, index) === nav)
    ? previous
    : [...index].find(([, destination]) => destination === nav)?.[0] ?? '';
  return { ...state, activeNav: nav, activeConvId };
}

export function selectChatConversation(state: ChatNavigationState, id: string, index: ReadonlyMap<string, ChatNavId>): ChatNavigationState {
  const destination = destinationForId(id, index);
  const activeNav = isChatNavigation(state.activeNav) ? destination ?? state.activeNav : state.activeNav;
  const selectionNav = destination ?? (isChatNavigation(activeNav) ? activeNav : null);
  if (id === state.activeConvId && activeNav === state.activeNav) return state;
  return {
    ...state, activeNav, activeConvId: id,
    selections: selectionNav ? { ...state.selections, [selectionNav]: id } : state.selections,
  };
}

export function reconcileChatNavigation(state: ChatNavigationState, index: ReadonlyMap<string, ChatNavId>, previousIndex: ReadonlyMap<string, ChatNavId> = new Map()): ChatNavigationState {
  for (const nav of ['chats', 'agent-chats'] as const) {
    const id = state.selections[nav];
    if (previousIndex.has(id) && !index.has(id)) {
      state = { ...state, selections: { ...state.selections, [nav]: '' }, activeConvId: state.activeConvId === id ? '' : state.activeConvId };
    }
  }
  if (!isChatNavigation(state.activeNav)) return state;
  if (state.activeConvId) return selectChatConversation(state, state.activeConvId, index);
  const first = [...index].find(([, destination]) => destination === state.activeNav)?.[0];
  return first ? selectChatConversation(state, first, index) : state;
}

import { useCallback, useState } from 'react';
import { CalendarDays, MessageSquare, MessagesSquare, Newspaper } from 'lucide-react';
import type { CompanionDocumentTabsModel } from '@/features/documents/useCompanionDocument';
import type { Conversation } from '@/kordi-app/types';
import type { CompanionView } from './chatsPage.companionToolbar';

export type CompanionToolView = Exclude<CompanionView, 'document'>;
const tools = {
  chat: { title: 'Chat', icon: MessageSquare },
  digest: { title: 'Digest', icon: Newspaper },
  calendar: { title: 'Calendar', icon: CalendarDays },
  discussion: { title: 'Discussion', icon: MessagesSquare },
};
export const companionViewTabId = (view: CompanionToolView) => `view:${view}`;
/** While a discussion is open, the toolbar's Chat button selects its tab. */
export const companionToolbarView = (view: CompanionView, hasDiscussion: boolean): CompanionView => view === 'chat' && hasDiscussion ? 'discussion' : view;

/** Tool tabs and document tabs share selection, closing, and the pane's lifetime.
 * The Discussion tab is listed only while a message discussion is open. */
export function useCompanionPaneTabs(conversationId: string, documents: CompanionDocumentTabsModel, chat: Pick<Conversation, 'name'> | null, hasDiscussion = false) {
  const hasChat = Boolean(chat);
  const [state, setState] = useState<{ conversationId: string; view: CompanionView; opened: CompanionToolView[] }>({ conversationId, view: 'chat', opened: hasChat ? ['chat'] : [] });
  const current = state.conversationId === conversationId ? state : { conversationId, view: 'chat' as const, opened: [] };
  const setView = useCallback((view: CompanionView) => {
    setState(previous => {
      const opened = previous.conversationId === conversationId ? previous.opened : [];
      return { conversationId, view, opened: view === 'document' || opened.includes(view) ? opened : [...opened, view] };
    });
  }, [conversationId]);
  const [availability, setAvailability] = useState({ conversationId, hasChat });
  if (availability.conversationId !== conversationId || availability.hasChat !== hasChat) {
    setAvailability({ conversationId, hasChat });
    if (hasChat) setState(previous => {
      const same = previous.conversationId === conversationId;
      if (same && previous.opened.includes('chat')) return previous;
      return { conversationId, view: same ? previous.view : 'chat', opened: [...(same ? previous.opened : []), 'chat'] };
    });
  }
  const opened = hasDiscussion ? current.opened : current.opened.filter(tool => tool !== 'discussion');
  const view = (current.view === 'document' && !documents.document) || (current.view === 'discussion' && !hasDiscussion)
    ? (opened[opened.length - 1] ?? 'chat') : current.view;
  const items = opened.map(view => ({ id: companionViewTabId(view), ...tools[view], title: view === 'chat' ? chat?.name.trim() || 'Chat' : tools[view].title }));
  const activeId = view === 'document' ? documents.activeId : companionViewTabId(view);
  const activate = (id: string) => {
    const tool = opened.find(view => companionViewTabId(view) === id);
    if (tool) setView(tool);
    else { documents.activate(id); setView('document'); }
  };
  /** Returns true when closing the last tab should fold the pane. */
  const close = (id: string) => {
    const tool = opened.find(view => companionViewTabId(view) === id);
    if (tool) {
      const remaining = opened.filter(view => view !== tool);
      const next = remaining[Math.min(opened.indexOf(tool), remaining.length - 1)];
      setState({ ...current, opened: remaining, view: activeId !== id ? view : next ?? (documents.documents.length ? 'document' : 'chat') });
      return !remaining.length && !documents.documents.length;
    }
    documents.closeTab(id);
    if (view === 'document' && documents.documents.length === 1 && opened.length) setView(opened[opened.length - 1]);
    return documents.documents.length === 1 && !opened.length;
  };
  return { view, setView, opened, items, activeId, activate, close, hasTabs: !!(items.length || documents.documents.length) };
}

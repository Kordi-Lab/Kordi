import { useCallback, useState } from 'react';
import { CalendarDays, MessageSquare, Newspaper } from 'lucide-react';
import type { CompanionDocumentTabsModel } from '@/features/documents/useCompanionDocument';
import type { Conversation } from '@/kordi-app/types';
import type { CompanionView } from './chatsPage.companionToolbar';

export type CompanionToolView = Exclude<CompanionView, 'document'>;
const tools = {
  chat: { title: 'Chat', icon: MessageSquare },
  digest: { title: 'Digest', icon: Newspaper },
  calendar: { title: 'Calendar', icon: CalendarDays },
};
export const companionViewTabId = (view: CompanionToolView) => `view:${view}`;

/** Tool tabs and document tabs share selection, closing, and the pane's lifetime. */
export function useCompanionPaneTabs(conversationId: string, documents: CompanionDocumentTabsModel, chat: Pick<Conversation, 'name'> | null) {
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
  const view = current.view === 'document' && !documents.document ? (current.opened[current.opened.length - 1] ?? 'chat') : current.view;
  const items = current.opened.map(view => ({ id: companionViewTabId(view), ...tools[view], title: view === 'chat' ? chat?.name.trim() || 'Chat' : tools[view].title }));
  const activeId = view === 'document' ? documents.activeId : companionViewTabId(view);
  const activate = (id: string) => {
    const tool = current.opened.find(view => companionViewTabId(view) === id);
    if (tool) setView(tool);
    else { documents.activate(id); setView('document'); }
  };
  /** Returns true when closing the last tab should fold the pane. */
  const close = (id: string) => {
    const tool = current.opened.find(view => companionViewTabId(view) === id);
    if (tool) {
      const opened = current.opened.filter(view => view !== tool);
      const next = opened[Math.min(current.opened.indexOf(tool), opened.length - 1)];
      setState({ ...current, opened, view: activeId !== id ? view : next ?? (documents.documents.length ? 'document' : 'chat') });
      return !opened.length && !documents.documents.length;
    }
    documents.closeTab(id);
    if (view === 'document' && documents.documents.length === 1 && current.opened.length) setView(current.opened[current.opened.length - 1]);
    return documents.documents.length === 1 && !current.opened.length;
  };
  return { view, setView, opened: current.opened, items, activeId, activate, close, hasTabs: !!(items.length || documents.documents.length) };
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { COMPANION_DOCUMENT_OPEN_EVENT, takePendingCompanionDocument, type CompanionDocument } from './companionDocument';
import { activateCompanionTab, closeCompanionTab, EMPTY_COMPANION_TABS, openCompanionTab, type CompanionTabs } from './companionTabsState';

/** The documents open as tabs in a conversation's companion pane; `document` is the active one. */
export function useCompanionDocument(conversationId: string) {
  const [state, setState] = useState<{ conversationId: string; tabs: CompanionTabs }>({ conversationId, tabs: EMPTY_COMPANION_TABS });
  const tabs = state.conversationId === conversationId ? state.tabs : EMPTY_COMPANION_TABS;
  const change = useCallback((update: (tabs: CompanionTabs) => CompanionTabs) => {
    setState((current) => ({ conversationId, tabs: update(current.conversationId === conversationId ? current.tabs : EMPTY_COMPANION_TABS) }));
  }, [conversationId]);
  const open = useCallback((next: CompanionDocument) => change((current) => openCompanionTab(current, next)), [change]);
  const activate = useCallback((id: string) => change((current) => activateCompanionTab(current, id)), [change]);
  const closeTab = useCallback((id: string) => change((current) => closeCompanionTab(current, id)), [change]);
  const close = useCallback(() => change(() => EMPTY_COMPANION_TABS), [change]);
  const document = tabs.documents.find((entry) => entry.artifact.id === tabs.activeId) ?? null;
  return { document, documents: tabs.documents, activeId: tabs.activeId, open, activate, closeTab, close };
}

export type CompanionDocumentTabsModel = ReturnType<typeof useCompanionDocument>;

/** Handles open requests from the Artifacts tab and transcript attachments, including one made before this page mounted. */
export function useCompanionDocumentRequests(onRequest: (document: CompanionDocument) => void) {
  const onRequestRef = useRef(onRequest);
  useLayoutEffect(() => { onRequestRef.current = onRequest; });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<CompanionDocument>).detail;
      if (!detail?.artifact) return;
      event.preventDefault();
      onRequestRef.current(detail);
    };
    window.addEventListener(COMPANION_DOCUMENT_OPEN_EVENT, handle);
    // A request made while no chat page was listening opens now.
    const pending = takePendingCompanionDocument();
    if (pending) onRequestRef.current(pending);
    return () => window.removeEventListener(COMPANION_DOCUMENT_OPEN_EVENT, handle);
  }, []);
}

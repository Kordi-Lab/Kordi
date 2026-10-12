import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { COMPANION_DOCUMENT_OPEN_EVENT, takePendingCompanionDocument, type CompanionDocument } from './companionDocument';

/** The document open in a conversation's companion pane. */
export function useCompanionDocument(conversationId: string) {
  const [state, setState] = useState<{ conversationId: string; document: CompanionDocument | null }>({ conversationId, document: null });
  const document = state.conversationId === conversationId ? state.document : null;
  const open = useCallback((next: CompanionDocument) => setState({ conversationId, document: next }), [conversationId]);
  const close = useCallback(() => setState({ conversationId, document: null }), [conversationId]);
  return { document, open, close };
}

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

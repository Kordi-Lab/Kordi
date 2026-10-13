import { X } from 'lucide-react';
import { useMemo } from 'react';

import { AppDialog } from '@/components/ui/dialog';
import type { CloudAccount } from '@/features/cloud/cloudIdentityTypes';

import { DocumentReaderHostContext, type DocumentReaderHost } from './documentReaderHost';
import { dispatchDocumentSessionOpen, usePendingDocumentShare } from './documentShareDeepLink';
import { DocumentReader } from './DocumentReader';
import type { DocumentShareApi } from './documentShareApi';

/** Reader for a `kordi://document/<token>` or `kordi.ai/d/<token>` link, read through the public route. */
export function DocumentShareLinkDialog({
  token,
  account,
  api,
  onDismiss,
}: {
  token: string;
  account: Pick<CloudAccount, 'accountId' | 'displayName' | 'kordiId' | 'avatarUrl'> | null;
  api?: DocumentShareApi;
  onDismiss: () => void;
}) {
  const host = useMemo<DocumentReaderHost>(() => ({
    viewer: account
      ? { accountId: account.accountId, displayName: account.displayName?.trim() || 'You', kordiId: account.kordiId ?? null, avatarUrl: account.avatarUrl }
      : null,
    sessionId: null,
    agentName: null,
    people: [],
  }), [account]);
  return (
    <AppDialog titleId="document-share-link-title" onDismiss={onDismiss} className="app-document-link-dialog">
      <h2 id="document-share-link-title" className="sr-only">Shared document</h2>
      <button type="button" className="app-document-link-close" aria-label="Close" onClick={onDismiss}>
        <X aria-hidden="true" />
      </button>
      <DocumentReaderHostContext.Provider value={host}>
        <DocumentReader
          shareToken={token}
          api={api}
          onOpenSession={(sessionId) => {
            dispatchDocumentSessionOpen(sessionId);
            onDismiss();
          }}
        />
      </DocumentReaderHostContext.Provider>
    </AppDialog>
  );
}

/** Mounted once in the signed-in shell; opens the reader for pending share links. */
export function DocumentShareLinkHost({ account }: { account: CloudAccount | null }) {
  const pending = usePendingDocumentShare();
  return pending.token
    ? <DocumentShareLinkDialog key={pending.token} token={pending.token} account={account} onDismiss={pending.dismiss} />
    : null;
}

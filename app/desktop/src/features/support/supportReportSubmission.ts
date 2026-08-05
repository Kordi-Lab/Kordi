import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react';

import type {
  CloudSupportTicketInput,
  CloudSupportTicketResult,
} from '@/features/cloud/supportClient';

export type SupportReportSubmissionState =
  | { stage: 'checking' }
  | { stage: 'pending' }
  | { stage: 'sending' }
  | { stage: 'sent'; ticketId: string }
  | { stage: 'error'; message: string }
  | { stage: 'lookup-error'; message: string };

export type SupportReportSubmission = {
  accountId: string;
  sessionId: string;
  onSubmit: (input: CloudSupportTicketInput) => Promise<CloudSupportTicketResult>;
  onLookup: (clientSubmissionId: string) => Promise<CloudSupportTicketResult | null>;
};

type AccountSubmissionStore = {
  records: Map<string, SupportReportSubmissionState>;
  lookupPromises: Map<string, Promise<void>>;
  submitPromises: Map<string, Promise<CloudSupportTicketResult>>;
  listeners: Set<() => void>;
};

const CHECKING_STATE: SupportReportSubmissionState = { stage: 'checking' };
const accountStores = new Map<string, AccountSubmissionStore>();

function accountStore(accountId: string): AccountSubmissionStore {
  let store = accountStores.get(accountId);
  if (!store) {
    store = {
      records: new Map(),
      lookupPromises: new Map(),
      submitPromises: new Map(),
      listeners: new Set(),
    };
    accountStores.set(accountId, store);
  }
  return store;
}

function submissionState(accountId: string, clientSubmissionId: string) {
  if (!accountId || !clientSubmissionId) return CHECKING_STATE;
  return accountStore(accountId).records.get(clientSubmissionId) ?? CHECKING_STATE;
}

function setSubmissionState(
  store: AccountSubmissionStore,
  clientSubmissionId: string,
  state: SupportReportSubmissionState,
) {
  store.records.set(clientSubmissionId, state);
  store.listeners.forEach((listener) => listener());
}

function caughtMessage(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function loadSubmissionState(
  accountId: string,
  clientSubmissionId: string,
  lookup: SupportReportSubmission['onLookup'],
  force = false,
) {
  const store = accountStore(accountId);
  const current = store.records.get(clientSubmissionId);
  if (!force && current) return Promise.resolve();
  const existing = store.lookupPromises.get(clientSubmissionId);
  if (existing) return existing;

  setSubmissionState(store, clientSubmissionId, CHECKING_STATE);
  const promise = Promise.resolve()
    .then(() => lookup(clientSubmissionId))
    .then((ticket) => {
      setSubmissionState(
        store,
        clientSubmissionId,
        ticket
          ? { stage: 'sent', ticketId: ticket.ticketId }
          : { stage: 'pending' },
      );
    })
    .catch((caught) => {
      setSubmissionState(store, clientSubmissionId, {
        stage: 'lookup-error',
        message: caughtMessage(
          caught,
          'The report status could not be restored. Check your connection and try again.',
        ),
      });
    })
    .finally(() => {
      if (store.lookupPromises.get(clientSubmissionId) === promise) {
        store.lookupPromises.delete(clientSubmissionId);
      }
    });
  store.lookupPromises.set(clientSubmissionId, promise);
  return promise;
}

function submitOnce(
  accountId: string,
  input: CloudSupportTicketInput,
  submit: SupportReportSubmission['onSubmit'],
) {
  const store = accountStore(accountId);
  const clientSubmissionId = input.clientSubmissionId;
  const existing = store.submitPromises.get(clientSubmissionId);
  if (existing) return existing;

  setSubmissionState(store, clientSubmissionId, { stage: 'sending' });
  const promise = Promise.resolve()
    .then(() => submit(input))
    .then((ticket) => {
      setSubmissionState(store, clientSubmissionId, {
        stage: 'sent',
        ticketId: ticket.ticketId,
      });
      return ticket;
    })
    .catch((caught) => {
      setSubmissionState(store, clientSubmissionId, {
        stage: 'error',
        message: caughtMessage(caught, 'The report could not be sent. Try again.'),
      });
      throw caught;
    })
    .finally(() => {
      if (store.submitPromises.get(clientSubmissionId) === promise) {
        store.submitPromises.delete(clientSubmissionId);
      }
    });
  store.submitPromises.set(clientSubmissionId, promise);
  return promise;
}

export const SupportReportSubmissionContext =
  createContext<SupportReportSubmission | null>(null);

export function useSupportReportSubmission(clientSubmissionId = '') {
  const submission = useContext(SupportReportSubmissionContext);
  const accountId = submission?.accountId ?? '';
  const subscribe = useCallback((listener: () => void) => {
    if (!accountId || !clientSubmissionId) return () => undefined;
    const store = accountStore(accountId);
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  }, [accountId, clientSubmissionId]);
  const getSnapshot = useCallback(
    () => submissionState(accountId, clientSubmissionId),
    [accountId, clientSubmissionId],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!submission || !clientSubmissionId) return;
    void loadSubmissionState(
      submission.accountId,
      clientSubmissionId,
      submission.onLookup,
    );
  }, [clientSubmissionId, submission]);

  const submit = useCallback(
    (input: CloudSupportTicketInput) => {
      if (!submission) return Promise.reject(new Error('Not signed in.'));
      return submitOnce(submission.accountId, input, submission.onSubmit);
    },
    [submission],
  );
  const retryLookup = useCallback(() => {
    if (!submission || !clientSubmissionId) return;
    void loadSubmissionState(
      submission.accountId,
      clientSubmissionId,
      submission.onLookup,
      true,
    );
  }, [clientSubmissionId, submission]);

  return submission ? { ...submission, state, submit, retryLookup } : null;
}

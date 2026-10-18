import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';

import type { AddContactLookupResult } from '@/pages/ChatCreateDialog';
import type { ContactRequest } from '../types';

export type PartitionedContactRequests = {
  incoming: ContactRequest[];
  outgoing: ContactRequest[];
  outgoingAccountIds: Set<string>;
};

export function partitionContactRequests(contactRequests: ContactRequest[]): PartitionedContactRequests {
  const incoming: ContactRequest[] = [];
  const outgoing: ContactRequest[] = [];
  const outgoingAccountIds = new Set<string>();
  for (const request of contactRequests) {
    const status = request.status?.trim().toLowerCase() || 'pending';
    if (status !== 'pending') continue;
    const direction = request.direction?.trim().toLowerCase();
    if (direction === 'outgoing') {
      outgoing.push(request);
      const accountId = (request.targetNodeId || request.detail).trim();
      if (accountId) outgoingAccountIds.add(accountId);
    } else {
      incoming.push(request);
    }
  }
  return { incoming, outgoing, outgoingAccountIds };
}

export function usePartitionedContactRequests(contactRequests: ContactRequest[]) {
  return useMemo(() => partitionContactRequests(contactRequests), [contactRequests]);
}

export type ContactRequestActionState = 'accepting' | 'rejecting' | null;

export type ContactRequestActions = {
  busy: boolean;
  canAccept: boolean;
  canReject: boolean;
  error: string;
  stateFor: (request: ContactRequest) => ContactRequestActionState;
  submit: (request: ContactRequest, kind: 'accept' | 'reject') => Promise<void>;
};

export function useContactRequestActions(
  onAcceptRequest?: (request: ContactRequest) => Promise<void> | void,
  onRejectRequest?: (request: ContactRequest) => Promise<void> | void,
): ContactRequestActions {
  const [action, setAction] = useState<{ requestId: string; kind: 'accept' | 'reject' } | null>(null);
  const [error, setError] = useState('');

  const stateFor = (request: ContactRequest): ContactRequestActionState => {
    if (action?.requestId !== request.id) return null;
    return action.kind === 'accept' ? 'accepting' : 'rejecting';
  };

  const submit = async (request: ContactRequest, kind: 'accept' | 'reject') => {
    const handler = kind === 'accept' ? onAcceptRequest : onRejectRequest;
    if (!handler || action) return;
    setAction({ requestId: request.id, kind });
    setError('');
    try {
      await handler(request);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to ${kind} contact request`);
    } finally {
      setAction(null);
    }
  };

  return { busy: Boolean(action), canAccept: Boolean(onAcceptRequest), canReject: Boolean(onRejectRequest), error, stateFor, submit };
}

export type AddContactState = 'idle' | 'saving' | 'sent' | 'pending' | 'error';

export function useAddContactForm({
  onLookupContact,
  onAddContactByNodeId,
  outgoingPendingRequestAccountIds,
}: {
  onLookupContact?: (idOrEmail: string) => Promise<AddContactLookupResult | null>;
  onAddContactByNodeId?: (nodeId: string) => Promise<void> | void;
  outgoingPendingRequestAccountIds: Set<string>;
}) {
  const [contactNodeId, setContactNodeId] = useState('');
  const [addContactState, setAddContactState] = useState<AddContactState>('idle');
  const [addContactError, setAddContactError] = useState('');
  const [lookupState, setLookupState] = useState<'idle' | 'searching' | 'error'>('idle');
  const [lookupError, setLookupError] = useState('');
  const [lookupResult, setLookupResult] = useState<AddContactLookupResult | null>(null);
  const [requestedContactNodeIds, setRequestedContactNodeIds] = useState<string[]>([]);

  const performContactLookup = async () => {
    if (!onLookupContact) return;
    const accountId = contactNodeId.trim();
    if (!accountId) return;
    setLookupState('searching');
    setLookupError('');
    setLookupResult(null);
    try {
      const result = await onLookupContact(accountId);
      if (!result) {
        setLookupState('error');
        setLookupError('No account found.');
        return;
      }
      setLookupResult(result);
      setLookupState('idle');
    } catch (error) {
      setLookupState('error');
      setLookupError(error instanceof Error ? error.message : 'Search failed.');
    }
  };

  const markRequested = (nodeId: string) => {
    setRequestedContactNodeIds((current) => (current.includes(nodeId) ? current : [...current, nodeId]));
  };

  const submitAddContact = async (nodeIdInput = lookupResult?.accountId ?? contactNodeId) => {
    const nodeId = nodeIdInput.trim();
    if (!nodeId || !onAddContactByNodeId || addContactState === 'saving') return;
    if (outgoingPendingRequestAccountIds.has(nodeId) || requestedContactNodeIds.includes(nodeId) || (lookupResult?.accountId === nodeId && lookupResult.isRequestPending)) {
      setAddContactState('pending');
      markRequested(nodeId);
      return;
    }
    setAddContactState('saving');
    setAddContactError('');
    try {
      await onAddContactByNodeId(nodeId);
      setAddContactState('sent');
      markRequested(nodeId);
      if (contactNodeId.trim() === nodeId) {
        setContactNodeId('');
        setLookupResult(null);
      }
    } catch (error) {
      setAddContactState('error');
      setAddContactError(error instanceof Error ? error.message : 'Unable to send contact request');
    }
  };

  const changeContactNodeId = (value: string) => {
    setContactNodeId(value);
    setLookupResult(null);
    setLookupState('idle');
    setLookupError('');
    if (addContactState !== 'saving') setAddContactState('idle');
  };

  const lookupRequestPending = Boolean(lookupResult && (lookupResult.isRequestPending || requestedContactNodeIds.includes(lookupResult.accountId)));

  const statusMessage = addContactState === 'sent'
    ? 'Request sent. Track it under Sent invites while they review it.'
    : addContactState === 'pending' || lookupRequestPending
      ? 'Request pending. Track it under Sent invites while they review it.'
      : addContactState === 'error'
        ? addContactError || 'Unable to send contact request.'
        : lookupState === 'error'
          ? lookupError || 'No account found.'
          : '';

  return {
    contactNodeId,
    changeContactNodeId,
    addContactState,
    lookupState,
    lookupResult,
    lookupRequestPending,
    requestedContactNodeIds,
    statusMessage,
    performContactLookup,
    submitAddContact,
  };
}

export type AddContactFormModel = ReturnType<typeof useAddContactForm>;

/** Reports whether the observed element is narrower than `threshold` pixels. */
export function useIsNarrowContainer(ref: RefObject<HTMLElement | null>, threshold: number) {
  const [isNarrow, setIsNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setIsNarrow(width > 0 && width < threshold);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return isNarrow;
}

/** Escape clears the current selection unless focus is in a text field. */
export function useEscapeToDeselect(enabled: boolean, onDeselect: () => void) {
  useEffect(() => {
    if (!enabled) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      onDeselect();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, onDeselect]);
}

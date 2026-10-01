import { createElement, useId, useState, type ReactNode } from 'react';

import { useCloudContacts } from '@/features/cloud/useCloudContacts';
import type { Conversation } from '@/kordi-app/types';

import { DirectConversationConsentNotice } from './DirectConversationConsentNotice';
import { directConversationConsentState, directPersonPeerAccountId } from './directConversationConsent';
import { useSafetyActions } from './safetyActions';
import { safetyErrorMessage } from './safetyCopy';
import { useCloudBlocks } from './useCloudBlocks';

export type DirectConversationConsent = {
  /** True while the chat is read-only because the two people are not contacts. */
  blocksSend: boolean;
  notice: ReactNode;
  /** The notice element's id, for the disabled send control's description. */
  noticeId: string | undefined;
};

/**
 * The consent notice for a person-to-person chat. It fails open: until the
 * contacts and block lists both load, nothing is shown and sending is left
 * to the server to accept or refuse.
 */
export function useDirectConversationConsent(
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'name'>,
  cloudAccountId: string | null,
): DirectConversationConsent {
  const safety = useSafetyActions();
  const noticeId = useId();
  const account = safety.account && safety.account.accountId === cloudAccountId ? safety.account : null;
  const peerAccountId = directPersonPeerAccountId(conversation, account?.accountId);
  const watchedAccount = peerAccountId && safety.safetyFeaturesAvailable ? account : null;
  const contacts = useCloudContacts(watchedAccount);
  const blocks = useCloudBlocks(watchedAccount);
  const [pending, setPending] = useState<{ peer: string; busy: boolean; error: string | null } | null>(null);

  const state = watchedAccount
    ? directConversationConsentState({ peerAccountId, contacts, blocks })
    : null;
  if (!state || state.kind === 'contact') return { blocksSend: false, notice: null, noticeId: undefined };

  const peer = state.peerAccountId;
  const name = conversation.name?.trim() || 'this person';
  const current = pending?.peer === peer ? pending : null;
  const run = (work: () => Promise<void> | void, failure: string) => {
    setPending({ peer, busy: true, error: null });
    Promise.resolve()
      .then(work)
      .then(() => setPending(null))
      .catch((error: unknown) => setPending({ peer, busy: false, error: safetyErrorMessage(error, failure) }));
  };
  const requestId = state.requestId;
  const notice = createElement(DirectConversationConsentNotice, {
    id: noticeId,
    kind: state.kind,
    name,
    busy: Boolean(current?.busy),
    error: current?.error ?? null,
    onUnblock: () => safety.openUnblock({ accountId: peer, name }),
    onBlock: () => safety.openBlock({ accountId: peer, name }),
    onAccept: () => run(() => (requestId ? contacts.acceptRequest(requestId) : undefined), "Couldn't accept the request. Try again."),
    onDecline: () => run(() => (requestId ? contacts.rejectRequest(requestId) : undefined), "Couldn't decline the request. Try again."),
    onWithdraw: () => run(() => (requestId ? safety.withdrawContactRequest(requestId) : undefined), "Couldn't withdraw the request. Try again."),
    onSendRequest: () => run(() => contacts.sendRequest(peer), "Couldn't send the contact request. Try again."),
  });
  return { blocksSend: true, notice, noticeId };
}

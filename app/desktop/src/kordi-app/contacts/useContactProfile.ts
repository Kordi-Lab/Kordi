import { useEffect, useRef, useState } from 'react';

import type { CloudContactProfile } from '@/features/cloud/contactProfileClient';
import type { Contact } from '../types';
import type { ContactProfileHost } from './contactProfileHost';

export type ContactProfileState =
  | { status: 'unavailable'; profile: null }
  | { status: 'loading'; profile: null }
  | { status: 'ready'; profile: CloudContactProfile }
  | { status: 'error'; profile: null };

type Settled = { accountId: string; state: ContactProfileState };

/**
 * Loads the richer profile when the pane opens. The pane renders right away from the contact row;
 * the profile only fills the cards, and any failure leaves today's content in place.
 */
export function useContactProfile(contact: Contact, host: ContactProfileHost | null | undefined): ContactProfileState {
  const accountId = host?.accountIdFor(contact) ?? null;
  const hostRef = useRef(host);
  useEffect(() => { hostRef.current = host; });
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    const current = hostRef.current;
    if (!accountId || !current) return undefined;
    const controller = new AbortController();
    current.load(accountId, controller.signal).then(
      (profile) => {
        if (!controller.signal.aborted) setSettled({ accountId, state: { status: 'ready', profile } });
      },
      () => {
        if (!controller.signal.aborted) setSettled({ accountId, state: { status: 'error', profile: null } });
      },
    );
    return () => controller.abort();
  }, [accountId]);

  if (!accountId) return { status: 'unavailable', profile: null };
  return settled?.accountId === accountId ? settled.state : { status: 'loading', profile: null };
}

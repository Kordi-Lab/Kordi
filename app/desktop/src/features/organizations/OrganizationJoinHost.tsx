import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { OrganizationJoinDialog, type OrganizationJoinActions } from './OrganizationJoinDialog';
import {
  fetchJoinableOrganizations,
  sendOrganizationEmailCode,
  submitOrganizationJoinRequest,
  verifyOrganizationEmailCode,
  type JoinableOrganizations,
} from './organizationJoinClient';
import {
  promptableOrganizations,
  readDismissedJoinIds,
  rememberDismissedJoinIds,
  subscribeOrganizationJoinOpenRequests,
} from './organizationJoinPrompt';
import { refreshOrganizations } from './useOrganizations';

type JoinView = { accountId: string; data: JoinableOrganizations | null; failed: boolean };

// Accounts already checked after sign-in in this app run.
const promptedAccounts = new Set<string>();

/**
 * Shows the "find your organization" dialog for the signed-in account: once
 * after sign-in when there is something new to join, and whenever
 * Settings › Account asks for it.
 */
export function OrganizationJoinHost({ accountId }: { accountId: string | null | undefined }) {
  const normalized = accountId?.trim() || null;
  const [view, setView] = useState<JoinView | null>(null);
  const loadRef = useRef(0);

  const accountRef = useRef(normalized);
  useEffect(() => { accountRef.current = normalized; }, [normalized]);

  useEffect(() => {
    if (!normalized || promptedAccounts.has(normalized)) return;
    promptedAccounts.add(normalized);
    // Not cancelled on cleanup, so a remounted host still gets the answer;
    // an account change in the meantime drops it.
    void fetchJoinableOrganizations().then((data) => {
      if (accountRef.current !== normalized) return;
      if (!promptableOrganizations(data, readDismissedJoinIds(normalized)).length) return;
      setView((current) => current ?? { accountId: normalized, data, failed: false });
    }, () => {
      // Older servers and offline starts skip the prompt this time.
      promptedAccounts.delete(normalized);
    });
  }, [normalized]);

  // Settings › Account asks for the dialog; the latest request wins.
  useEffect(() => subscribeOrganizationJoinOpenRequests(() => {
    if (!normalized) return;
    const load = ++loadRef.current;
    setView({ accountId: normalized, data: null, failed: false });
    void fetchJoinableOrganizations().then(
      (data) => { if (loadRef.current === load) setView({ accountId: normalized, data, failed: false }); },
      () => { if (loadRef.current === load) setView({ accountId: normalized, data: null, failed: true }); },
    );
  }), [normalized]);

  const email = view?.data?.email ?? null;
  const actions = useMemo<OrganizationJoinActions>(() => ({
    sendCode: (organization) => {
      if (!email) return Promise.reject(new Error('Verify your email first.'));
      return sendOrganizationEmailCode(organization, email);
    },
    verifyCode: (organization, verificationId, code) => verifyOrganizationEmailCode(organization, verificationId, code),
    request: (organization, fields) => submitOrganizationJoinRequest(organization, fields),
  }), [email]);

  const close = useCallback(() => {
    if (view?.data) rememberDismissedJoinIds(view.accountId, view.data.organizations.map((item) => item.id));
    setView(null);
  }, [view]);

  // A direct join refreshes the organization list; the selection stays as it was.
  const onJoined = useCallback(() => {
    if (normalized) void refreshOrganizations(normalized, { force: true });
  }, [normalized]);

  // A dialog left open for another account is dropped, so it cannot come back later.
  if (view && view.accountId !== normalized) setView(null);
  if (!view || view.accountId !== normalized) return null;
  return <OrganizationJoinDialog data={view.data} failed={view.failed} actions={actions} onJoined={onJoined} onClose={close} />;
}

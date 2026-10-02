// App-level provider for block, report, contact removal, and request
// withdrawal. It is mounted once around the app shell, so menus, popovers, and
// portaled dialogs reach it through React context without prop threading.

import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { CloudAuthError, defaultCloudAuthClient, type CloudAccount } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { forgetCloudContact, useCloudContacts } from '@/features/cloud/useCloudContacts';

import { BlockAccountDialog } from './BlockAccountDialog';
import { ReportDialog } from './ReportDialog';
import { SafetyActionsContext, type SafetyActions } from './safetyActions';
import {
  blockAccount,
  createReport,
  removeContact,
  resolveCloudConversationId,
  unblockAccount,
  withdrawContactRequest,
} from './safetyClient';
import type { CloudReportInput, ReportTarget, SafetyAccountTarget } from './safetyTypes';
import { isServiceAccountId } from './serviceAccounts';
import {
  forgetBlockedAccount,
  refreshCloudBlocks,
  rememberBlockedAccount,
  useCloudBlocks,
} from './useCloudBlocks';

type SafetyDialog =
  | { kind: 'block' | 'unblock'; target: SafetyAccountTarget }
  | { kind: 'report'; target: ReportTarget };

export function SafetyActionsProvider({ account, children }: { account: CloudAccount | null; children: ReactNode }) {
  const client = useMemo(() => defaultCloudAuthClient(), []);
  const blocks = useCloudBlocks(account);
  // The contacts store's refresh is a stable callback, so it can be held directly.
  const contactsStore: { refresh: () => Promise<void> } = useCloudContacts(account);
  const refreshContacts = contactsStore.refresh;
  const [dialog, setDialog] = useState<SafetyDialog | null>(null);
  const accountId = account?.accountId ?? null;
  const safetyFeaturesAvailable = Boolean(accountId) && blocks.loaded && blocks.available;
  const blockedAccountIds = useMemo(
    () => new Set(blocks.blocks.map((block) => block.accountId)),
    [blocks.blocks],
  );

  const sessionToken = useCallback(async () => {
    const session = await loadSession();
    if (!session?.token || !accountId || session.accountId !== accountId) {
      throw new CloudAuthError('invalid_session', 'Sign in again to continue.', 401);
    }
    return session.token;
  }, [accountId]);

  const block = useCallback(async (target: SafetyAccountTarget) => {
    const token = await sessionToken();
    const result = await blockAccount(client, token, target.accountId);
    if (accountId) {
      rememberBlockedAccount(accountId, result.block);
      forgetCloudContact(accountId, target.accountId);
      void refreshCloudBlocks(accountId);
    }
    void refreshContacts();
  }, [accountId, client, refreshContacts, sessionToken]);

  const unblock = useCallback(async (target: SafetyAccountTarget) => {
    const token = await sessionToken();
    await unblockAccount(client, token, target.accountId);
    if (accountId) {
      forgetBlockedAccount(accountId, target.accountId);
      void refreshCloudBlocks(accountId);
    }
    void refreshContacts();
  }, [accountId, client, refreshContacts, sessionToken]);

  const submitReport = useCallback(async (input: CloudReportInput) => {
    const token = await sessionToken();
    if (!input.conversationId) return createReport(client, token, input);
    const conversationId = await resolveCloudConversationId(client, token, input.conversationId);
    if (!conversationId) {
      throw new CloudAuthError(
        'invalid_report_evidence',
        "Some selected messages can't be included. Refresh the chat and try again.",
        400,
      );
    }
    return createReport(client, token, { ...input, conversationId });
  }, [client, sessionToken]);

  const value = useMemo<SafetyActions>(() => ({
    account,
    safetyFeaturesAvailable,
    blockedAccountIds,
    openBlock: (target) => { if (safetyFeaturesAvailable) setDialog({ kind: 'block', target }); },
    openUnblock: (target) => { if (safetyFeaturesAvailable) setDialog({ kind: 'unblock', target }); },
    openReport: (target) => { if (safetyFeaturesAvailable) setDialog({ kind: 'report', target }); },
    removeContact: async (peerAccountId) => {
      await removeContact(client, await sessionToken(), peerAccountId);
      if (accountId) forgetCloudContact(accountId, peerAccountId);
      await refreshContacts();
    },
    withdrawContactRequest: async (requestId) => {
      await withdrawContactRequest(client, await sessionToken(), requestId);
      await refreshContacts();
    },
  }), [account, accountId, blockedAccountIds, client, refreshContacts, safetyFeaturesAvailable, sessionToken]);

  const dismiss = useCallback(() => setDialog(null), []);
  const reportTarget = dialog?.kind === 'report' ? dialog.target : null;
  const reportedAccountId = reportTarget?.accountId ?? null;
  const canBlockReported = Boolean(
    reportedAccountId
      && reportedAccountId !== accountId
      && !isServiceAccountId(reportedAccountId)
      && !blockedAccountIds.has(reportedAccountId),
  );

  return (
    <SafetyActionsContext.Provider value={value}>
      {children}
      {dialog && dialog.kind !== 'report' ? (
        <BlockAccountDialog
          key={`${dialog.kind}:${dialog.target.accountId}`}
          mode={dialog.kind}
          target={dialog.target}
          onDismiss={dismiss}
          onConfirm={() => (dialog.kind === 'block' ? block(dialog.target) : unblock(dialog.target))}
          onReport={() => setDialog({ kind: 'report', target: { accountId: dialog.target.accountId, name: dialog.target.name } })}
        />
      ) : null}
      {reportTarget ? (
        <ReportDialog
          key={`report:${reportTarget.accountId ?? ''}:${(reportTarget.messageIds ?? []).join(',')}`}
          target={reportTarget}
          onDismiss={dismiss}
          onSubmit={submitReport}
          onBlock={canBlockReported && reportedAccountId
            ? () => block({ accountId: reportedAccountId, name: reportTarget.name })
            : undefined}
        />
      ) : null}
    </SafetyActionsContext.Provider>
  );
}

// App-level provider for Block, Unblock, and Report. It is mounted once
// around the app shell, so menus, panes, and settings reach it through
// context, and its dialogs portal above every other surface.

import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { CloudAuthError, type CloudAccount } from '@/features/cloud/authClient';
import { useCloudContacts } from '@/features/cloud/useCloudContacts';

import { BlockAccountDialog } from './BlockAccountDialog';
import { ReportDialog } from './ReportDialog';
import { SafetyActionsContext, type SafetyActions } from './safetyActions';
import { defaultSafetyDeps, safetySessionToken, type SafetyDeps } from './safetyClient';
import type { CloudReportInput, ReportTarget, SafetyAccountTarget } from './safetyTypes';
import { isServiceAccountId } from './serviceAccounts';
import { forgetBlockedAccount, refreshCloudBlocks, rememberBlockedAccount, useCloudBlocks } from './useCloudBlocks';

type SafetyDialog =
  | { kind: 'block'; target: SafetyAccountTarget; onBlocked?: () => void }
  | { kind: 'unblock'; target: SafetyAccountTarget }
  | { kind: 'report'; target: ReportTarget };

type SafetyActionsProviderProps = {
  accountId: string | null;
  /** Reloads contacts after a block or unblock, as after deleting a contact. */
  refreshContacts: () => Promise<void>;
  /** Client and session override for previews and tests. */
  deps?: SafetyDeps;
  children: ReactNode;
};

export function SafetyActionsProvider({ accountId, refreshContacts, deps: depsOverride, children }: SafetyActionsProviderProps) {
  const deps = useMemo(() => depsOverride ?? defaultSafetyDeps(), [depsOverride]);
  const blocks = useCloudBlocks(accountId, deps);
  const [dialog, setDialog] = useState<SafetyDialog | null>(null);
  const available = Boolean(accountId) && blocks.loaded && blocks.available;
  const blockedAccountIds = useMemo(() => new Set(blocks.blocks.map((block) => block.accountId)), [blocks.blocks]);

  const afterDirectoryChange = useCallback(() => {
    if (accountId) void refreshCloudBlocks(accountId, deps);
    void refreshContacts().catch(() => undefined);
  }, [accountId, deps, refreshContacts]);

  const block = useCallback(async (target: SafetyAccountTarget) => {
    const result = await deps.client.block(await safetySessionToken(deps, accountId), target.accountId);
    if (accountId) rememberBlockedAccount(accountId, result.block);
    afterDirectoryChange();
  }, [accountId, afterDirectoryChange, deps]);

  const unblock = useCallback(async (target: SafetyAccountTarget) => {
    await deps.client.unblock(await safetySessionToken(deps, accountId), target.accountId);
    if (accountId) forgetBlockedAccount(accountId, target.accountId);
    afterDirectoryChange();
  }, [accountId, afterDirectoryChange, deps]);

  const submitReport = useCallback(async (input: CloudReportInput) => {
    const token = await safetySessionToken(deps, accountId);
    let body = input;
    if (input.conversationId) {
      const conversationId = await deps.client.resolveConversationId(token, input.conversationId);
      if (!conversationId) throw new CloudAuthError('invalid_report_evidence', "This message can't be reported.", 400);
      body = { ...input, conversationId };
    }
    const result = await deps.client.report(token, body);
    if (result.blocked && input.reportedAccountId && accountId) {
      rememberBlockedAccount(accountId, {
        accountId: input.reportedAccountId,
        kordiId: '',
        displayName: result.report.reportedDisplayName,
        avatarUrl: null,
        blockedAt: new Date().toISOString(),
      });
      afterDirectoryChange();
    }
  }, [accountId, afterDirectoryChange, deps]);

  const value = useMemo<SafetyActions>(() => ({
    available,
    blocks: blocks.blocks,
    blocksLoaded: blocks.loaded,
    blocksError: blocks.error,
    blockedAccountIds,
    openBlock: (target, onBlocked) => { if (available) setDialog({ kind: 'block', target, onBlocked }); },
    openUnblock: (target) => { if (available) setDialog({ kind: 'unblock', target }); },
    openReport: (target) => { if (available) setDialog({ kind: 'report', target }); },
    refreshBlocks: blocks.refresh,
  }), [available, blockedAccountIds, blocks.blocks, blocks.error, blocks.loaded, blocks.refresh]);

  const dismiss = useCallback(() => setDialog(null), []);
  const reportedAccountId = dialog?.kind === 'report' ? dialog.target.accountId : null;
  const canBlockReported = Boolean(
    reportedAccountId
      && reportedAccountId !== accountId
      && !isServiceAccountId(reportedAccountId)
      && !blockedAccountIds.has(reportedAccountId),
  );

  return (
    <SafetyActionsContext.Provider value={value}>
      {children}
      {dialog?.kind === 'block' ? (
        <BlockAccountDialog
          key={`block:${dialog.target.accountId}`}
          mode="block"
          target={dialog.target}
          onDismiss={dismiss}
          onConfirm={async () => {
            await block(dialog.target);
            dialog.onBlocked?.();
          }}
        />
      ) : null}
      {dialog?.kind === 'unblock' ? (
        <BlockAccountDialog
          key={`unblock:${dialog.target.accountId}`}
          mode="unblock"
          target={dialog.target}
          onDismiss={dismiss}
          onConfirm={() => unblock(dialog.target)}
        />
      ) : null}
      {dialog?.kind === 'report' ? (
        <ReportDialog
          key={`report:${dialog.target.accountId ?? ''}:${(dialog.target.messageIds ?? []).join(',')}`}
          target={dialog.target}
          canBlock={canBlockReported}
          onSubmit={submitReport}
          onDismiss={dismiss}
        />
      ) : null}
    </SafetyActionsContext.Provider>
  );
}

/** The provider for the signed-in hosted account, wired to its contacts store. */
export function CloudSafetyActionsProvider({ account, children }: { account: CloudAccount | null; children: ReactNode }) {
  const contacts = useCloudContacts(account);
  const refreshContacts = useCallback(() => contacts.refresh(), [contacts]);
  return (
    <SafetyActionsProvider accountId={account?.accountId ?? null} refreshContacts={refreshContacts}>
      {children}
    </SafetyActionsProvider>
  );
}

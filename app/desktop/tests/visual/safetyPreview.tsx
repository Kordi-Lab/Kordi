// Synthetic preview of Settings › Blocked and the Block and Report dialogs.
// ?dialog=report (default) | message | sent | block | none, ?theme=light|dark.
import './previewChatTheme';
import { StrictMode, useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import { BlockedAccountsPanel } from '../../src/features/safety/BlockedAccountsPanel';
import { ReportDialog } from '../../src/features/safety/ReportDialog';
import { useSafetyActions } from '../../src/features/safety/safetyActions';
import type { SafetyDeps } from '../../src/features/safety/safetyClient';
import { SafetyActionsProvider } from '../../src/features/safety/SafetyActionsProvider';
import type { CloudBlockedAccount, ReportTarget, SafetyAccountTarget } from '../../src/features/safety/safetyTypes';
import '../../src/index.css';

const ACCOUNT_ID = 'acct_preview';
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const dialog = params.get('dialog') ?? 'report';
localStorage.setItem('kordi.themeMode.v1', theme);

const blocked = (accountId: string, displayName: string, kordiId: string, daysAgo: number): CloudBlockedAccount => ({
  accountId, displayName, kordiId, avatarUrl: null, blockedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
});
let blocks: CloudBlockedAccount[] = [
  blocked('acct_preview_jordan', 'Jordan Vale', '412093857', 1),
  blocked('acct_preview_casey', 'Casey Morrow', '730184562', 6),
  blocked('acct_preview_riley', 'Riley Stone', '590237148', 30),
];

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const deps: SafetyDeps = {
  loadSession: async () => ({ token: 'preview', accountId: ACCOUNT_ID }),
  client: {
    async listBlocks() { await pause(); return [...blocks]; },
    async block(_token, accountId) {
      await pause();
      const row = blocked(accountId, 'Avery Lane', '381920475', 0);
      blocks = [row, ...blocks.filter((item) => item.accountId !== accountId)];
      return { block: row, removedContact: true };
    },
    async unblock(_token, accountId) { await pause(); blocks = blocks.filter((item) => item.accountId !== accountId); },
    async report(_token, input) {
      await pause();
      return {
        report: {
          reportId: 'rep_preview', reference: 'R-PREVIEW1', status: 'received', reason: input.reason,
          targetKind: input.messageIds?.length ? 'message' : 'account', evidenceMessageCount: input.messageIds?.length ?? 0,
          reportedDisplayName: 'Avery Lane', createdAt: new Date().toISOString(), closedAt: null,
        },
        blocked: input.alsoBlock === true,
      };
    },
    async resolveConversationId(_token, id) { return id; },
  },
};

const person: SafetyAccountTarget = { accountId: 'acct_preview_avery', name: 'Avery Lane' };
const personTarget: ReportTarget = person;
const messageTarget: ReportTarget = {
  ...personTarget,
  conversationId: '00000000-0000-4000-8000-000000000001',
  messageIds: ['00000000-0000-4000-8000-000000000002'],
};

function OpenDialog() {
  const safety = useSafetyActions();
  const opened = useRef(false);
  useEffect(() => {
    // Open once, when blocking becomes available.
    if (!safety.available || opened.current) return;
    opened.current = true;
    if (dialog === 'report') safety.openReport(personTarget);
    if (dialog === 'message') safety.openReport(messageTarget);
    if (dialog === 'block') safety.openBlock(person);
  }, [safety]);
  return null;
}

function SafetyPreview() {
  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, []);

  return (
    <SafetyActionsProvider accountId={ACCOUNT_ID} refreshContacts={() => Promise.resolve()} deps={deps}>
      <div
        className={`kordi-app theme-${theme} grid min-h-screen place-items-center p-6`}
        style={theme === 'dark'
          ? { background: '#101824', color: 'rgb(255 255 255)' }
          : { background: 'var(--app-main-bg)', color: 'rgb(15 23 42)' }}
      >
        <div className="app-transient-surface app-modal-panel app-cloud-account-settings-dialog w-[min(760px,calc(100vw-40px))] overflow-hidden rounded-[12px]">
          <div className="app-main-panel app-cloud-account-settings-page">
            <div className="px-8 pb-8 pt-10">
              <BlockedAccountsPanel />
            </div>
          </div>
        </div>
        <OpenDialog />
        {dialog === 'sent' ? (
          <ReportDialog target={personTarget} canBlock onSubmit={() => Promise.resolve()} onDismiss={() => undefined} initialStage="sent" />
        ) : null}
      </div>
    </SafetyActionsProvider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><SafetyPreview /></StrictMode>);

import { useEffect, useState } from 'react';

import { AppShellFrame } from '@/app/AppShellFrame';
import { useKordiAppModel } from '@/app/useKordiAppModel';
import { currentKordiEdition, shouldShowCloudLoginGate, type CloudSessionStatus, type KordiEdition } from '@/features/cloud/edition';
import { applyKordiMainWindowSize } from '@/features/cloud/loginWindow';
import { useCloudSession, type UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { CloudContactsPanel } from '@/features/cloud/CloudContactsPanel';
import { CloudLoginPage } from '@/kordi-app/cloud/CloudLoginPage';
import { setLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { CloudAccount } from '@/features/cloud/authClient';

const AVATAR_URL_PREFIX = 'kordi-pixel-avatar://';

export type KordiAppRootProps = {
  edition?: KordiEdition;
  /**
   * Tests can pass an explicit cloudSessionStatus to render the gate or the
   * shell deterministically. When undefined, the runtime hook drives the
   * gate based on the OS keychain + cloud server.
   */
  cloudSessionStatus?: CloudSessionStatus;
  /** Optional injected hook result for testing without a real Tauri/fetch env. */
  cloudSession?: Pick<UseCloudSessionResult, 'status' | 'account' | 'signIn' | 'signUp'>;
};

export function KordiAppRoot({
  edition = currentKordiEdition(),
  cloudSessionStatus,
  cloudSession,
}: KordiAppRootProps = {}) {
  // When edition is local, we don't need any cloud session machinery and
  // shouldShowCloudLoginGate short-circuits anyway. We default to 'signed-out'
  // so existing call sites that relied on the old default keep working.
  if (edition !== 'cloud') {
    if (shouldShowCloudLoginGate({ edition, cloudSessionStatus: cloudSessionStatus ?? 'signed-out' })) {
      return <CloudLoginPage />;
    }
    return <KordiAppShell />;
  }

  return (
    <CloudEditionRoot
      cloudSessionStatusOverride={cloudSessionStatus}
      cloudSessionOverride={cloudSession}
    />
  );
}

function CloudEditionRoot({
  cloudSessionStatusOverride,
  cloudSessionOverride,
}: {
  cloudSessionStatusOverride?: CloudSessionStatus;
  cloudSessionOverride?: Pick<UseCloudSessionResult, 'status' | 'account' | 'signIn' | 'signUp'>;
}) {
  // Tests can hand us a stubbed session result; in production we use the hook.
  const liveSession = useCloudSession({
    enabled: cloudSessionOverride === undefined,
  });
  const session = cloudSessionOverride ?? liveSession;
  const status: CloudSessionStatus = cloudSessionStatusOverride ?? session.status;
  const account = session.account ?? null;

  // Mirror the cloud account's avatar choice into the local profile slot so
  // the desktop shell renders the user's chosen pixel character (bottom-left
  // of the chat workspace, transcript "you" rows, etc.) instead of a fresh
  // generic seed. Display name sync lives in a follow-up.
  useEffect(() => {
    if (status !== 'authenticated' || !account?.avatarUrl) return;
    if (!account.avatarUrl.startsWith(AVATAR_URL_PREFIX)) return;
    const seed = account.avatarUrl.slice(AVATAR_URL_PREFIX.length).trim();
    if (!seed) return;
    setLocalProfileAvatarSeed(seed);
  }, [status, account?.avatarUrl]);

  if (shouldShowCloudLoginGate({ edition: 'cloud', cloudSessionStatus: status })) {
    return (
      <CloudLoginPage
        onSignIn={session.signIn}
        onSignUp={session.signUp}
      />
    );
  }
  if (status === 'loading') {
    return <CloudGateLoading />;
  }
  return (
    <>
      <KordiAppShell />
      {account ? <CloudContactsLauncher account={account} /> : null}
    </>
  );
}

function CloudContactsLauncher({ account }: { account: CloudAccount }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open cloud contacts"
        className="fixed bottom-5 right-5 z-[150] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-slate-950/90 text-slate-100 shadow-lg backdrop-blur transition hover:bg-slate-900"
        title="Cloud contacts"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} className="h-5 w-5">
          <circle cx="9" cy="9" r="3.5" />
          <path strokeLinecap="round" d="M3.5 18.2c.6-2.6 2.7-4.3 5.5-4.3 2 0 3.7.9 4.7 2.3" />
          <circle cx="17" cy="14" r="2.4" />
          <path strokeLinecap="round" d="M14.6 19.6c.4-1.7 1.5-2.6 2.9-2.6 1 0 1.9.4 2.5 1.2" />
        </svg>
      </button>
      {open ? <CloudContactsPanel account={account} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CloudGateLoading() {
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-[oklch(0.955_0.026_82)] text-[12px] font-semibold uppercase tracking-[0.18em] text-[oklch(0.52_0.025_82/0.62)]"
      aria-live="polite"
      aria-busy="true"
    >
      Restoring session…
    </div>
  );
}

function KordiAppShell() {
  useEffect(() => {
    void applyKordiMainWindowSize();
  }, []);

  const appShellFrameProps = useKordiAppModel();
  return <AppShellFrame {...appShellFrameProps} />;
}

export default function KordiApp() {
  return <KordiAppRoot />;
}

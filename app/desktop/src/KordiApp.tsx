import { useEffect } from 'react';

import { AppShellFrame } from '@/app/AppShellFrame';
import { useKordiAppModel } from '@/app/useKordiAppModel';
import { currentKordiEdition, shouldShowCloudLoginGate, type CloudSessionStatus, type KordiEdition } from '@/features/cloud/edition';
import { applyKordiMainWindowSize } from '@/features/cloud/loginWindow';
import { useCloudSession, type UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { CloudLoginPage } from '@/kordi-app/cloud/CloudLoginPage';
import { setLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';

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
  cloudSession?: Pick<UseCloudSessionResult, 'status' | 'account' | 'signIn' | 'signUp' | 'signInWithProvider'>;
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
  cloudSessionOverride?: Pick<UseCloudSessionResult, 'status' | 'account' | 'signIn' | 'signUp' | 'signInWithProvider'>;
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
        onSocialSignIn={session.signInWithProvider}
      />
    );
  }
  if (status === 'loading') {
    return <CloudGateLoading />;
  }
  return <KordiAppShell />;
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

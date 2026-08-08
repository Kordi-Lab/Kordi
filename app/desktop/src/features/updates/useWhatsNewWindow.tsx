import { useCallback, useEffect, useState } from 'react';

import { isNativeDesktopShell, openDesktopExternalUrl } from '@/lib/desktop';
import { WhatsNewDialog } from '@/features/updates/WhatsNewDialog';
import {
  loadWhatsNewRelease,
  markWhatsNewPresented,
  type WhatsNewRelease,
  type WhatsNewRuntime,
} from '@/features/updates/whatsNew';

const RELEASE_METADATA_TIMEOUT_MS = 8_000;

async function currentDesktopVersion() {
  const app = await import('@tauri-apps/api/app');
  return app.getVersion();
}

type WhatsNewLaunchWindowProps = {
  runtime?: Partial<WhatsNewRuntime>;
};

export function WhatsNewLaunchWindow({ runtime }: WhatsNewLaunchWindowProps = {}) {
  const [release, setRelease] = useState<WhatsNewRelease | null>(null);
  const isNativeShell = runtime?.isNativeShell ?? isNativeDesktopShell();
  const currentVersion = runtime?.currentVersion ?? currentDesktopVersion;
  const fetchImpl = runtime?.fetchImpl;
  const baseUrl = runtime?.baseUrl;
  const storage = runtime?.storage;

  useEffect(() => {
    if (!isNativeShell) return undefined;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), RELEASE_METADATA_TIMEOUT_MS);
    let active = true;
    void loadWhatsNewRelease({
      isNativeShell,
      currentVersion,
      fetchImpl,
      baseUrl,
      storage,
      signal: controller.signal,
    }).then((nextRelease) => {
      if (active) setRelease(nextRelease);
    }).finally(() => {
      window.clearTimeout(timeout);
    });
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [baseUrl, currentVersion, fetchImpl, isNativeShell, storage]);

  const handlePresented = useCallback(() => {
    if (release) markWhatsNewPresented(release, storage);
  }, [release, storage]);

  const changelogUrl = release?.changelogUrl;
  const handleOpenFullReleaseNotes = useCallback(() => {
    if (!changelogUrl) return;
    void openDesktopExternalUrl(changelogUrl).catch(() => undefined);
  }, [changelogUrl]);

  if (!release) return null;
  return (
    <WhatsNewDialog
      release={release}
      onDismiss={() => setRelease(null)}
      onPresented={handlePresented}
      onOpenFullReleaseNotes={changelogUrl ? handleOpenFullReleaseNotes : undefined}
    />
  );
}

import { useEffect } from 'react';

import { AppShellFrame } from '@/app/AppShellFrame';
import { useKordiAppModel } from '@/app/useKordiAppModel';
import { currentKordiEdition, shouldShowCloudLoginGate, type CloudSessionStatus, type KordiEdition } from '@/features/cloud/edition';
import { applyKordiMainWindowSize } from '@/features/cloud/loginWindow';
import { CloudLoginPage } from '@/kordi-app/cloud/CloudLoginPage';

export function KordiAppRoot({
  edition = currentKordiEdition(),
  cloudSessionStatus = 'signed-out',
}: {
  edition?: KordiEdition;
  cloudSessionStatus?: CloudSessionStatus;
}) {
  if (shouldShowCloudLoginGate({ edition, cloudSessionStatus })) {
    return <CloudLoginPage />;
  }

  return <KordiAppShell />;
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

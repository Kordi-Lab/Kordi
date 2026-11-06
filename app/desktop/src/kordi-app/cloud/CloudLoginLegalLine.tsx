import type { MouseEvent } from 'react';

import { openDesktopExternalUrl } from '@/lib/desktop';

export const KORDI_TERMS_URL = 'https://kordi.ai/terms';
export const KORDI_PRIVACY_URL = 'https://kordi.ai/privacy';

function openInBrowser(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  void openDesktopExternalUrl(event.currentTarget.href).catch(() => undefined);
}

/** "By continuing you agree to the Terms and Privacy Policy." with links that open in the system browser. */
export function CloudLoginLegalLine({ className }: { className?: string }) {
  return (
    <p className={className} data-cloud-login-legal="">
      By continuing you agree to the{' '}
      <a href={KORDI_TERMS_URL} onClick={openInBrowser}>Terms</a>
      {' '}and{' '}
      <a href={KORDI_PRIVACY_URL} onClick={openInBrowser}>Privacy Policy</a>.
    </p>
  );
}

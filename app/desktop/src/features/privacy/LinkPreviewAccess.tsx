import type { ReactNode } from 'react';

import { LinkNetworkAccessContext, LinkPreviewTrustContext } from './linkNetworkAccess';

/** Supplies the contacts whose links may load previews under the default setting. */
export function LinkPreviewTrustProvider({
  trustedHumanIds,
  children,
}: {
  trustedHumanIds: ReadonlySet<string>;
  children: ReactNode;
}) {
  return <LinkPreviewTrustContext.Provider value={trustedHumanIds}>{children}</LinkPreviewTrustContext.Provider>;
}

/** Records whether links inside this subtree may contact their websites. */
export function LinkNetworkAccessProvider({
  allowed,
  children,
}: {
  allowed: boolean;
  children: ReactNode;
}) {
  return <LinkNetworkAccessContext.Provider value={allowed}>{children}</LinkNetworkAccessContext.Provider>;
}

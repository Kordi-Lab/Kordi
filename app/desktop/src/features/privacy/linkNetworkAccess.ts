import { createContext, useContext } from 'react';

import {
  messageAllowsLinkNetwork,
  useLinkPreviewPreference,
  type LinkPreviewPolicyMessage,
} from './linkPreviewPolicy';

// Contexts and hooks live in this module so the provider components in
// LinkPreviewAccess.tsx keep a components-only export surface.

const EMPTY_TRUSTED_HUMAN_IDS: ReadonlySet<string> = Object.freeze(new Set<string>());

/** Account ids whose links may load previews under the default setting. */
export const LinkPreviewTrustContext = createContext<ReadonlySet<string>>(EMPTY_TRUSTED_HUMAN_IDS);

/**
 * The link network decision for the message being rendered. `null` means no
 * per-message decision (Digest, the artifact inspector, and other surfaces
 * outside a conversation); those surfaces fetch only under "Everyone".
 */
export const LinkNetworkAccessContext = createContext<boolean | null>(null);

export function useLinkNetworkAccess(): boolean {
  const decision = useContext(LinkNetworkAccessContext);
  const preference = useLinkPreviewPreference();
  return decision ?? preference === 'everyone';
}

export function useMessageLinkNetworkAccess(message: LinkPreviewPolicyMessage): boolean {
  const preference = useLinkPreviewPreference();
  const trustedHumanIds = useContext(LinkPreviewTrustContext);
  return messageAllowsLinkNetwork(preference, message, trustedHumanIds);
}

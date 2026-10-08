// Chat affordance for connectors (issue 1712, PR 5). The agent's
// `connectors_request_connect` tool answers with a
// `kordi://settings/connectors?provider=<id>` link. Clicking it in a message
// opens account settings on the Connectors tab with that provider selected;
// the person connects the service there. The link never grants anything.

export const CONNECTORS_SETTINGS_LINK_EVENT = 'kordi:open-connectors-settings';

export const CONNECTORS_LINK_PROVIDER_IDS = ['gmail', 'google_calendar', 'github', 'slack'] as const;

export type ConnectorsLinkProviderId = (typeof CONNECTORS_LINK_PROVIDER_IDS)[number];

export type ConnectorsSettingsTarget = {
  tab: 'connectors';
  providerId: ConnectorsLinkProviderId | null;
};

const bareConnectorsLinkPattern = /^kordi:\/\/settings\/connectors\/?(?:\?[^\s<>"'()[\]]*)?/i;
export const connectorsLinkStartPattern = /kordi:\/\/settings\/connectors/i;

function isProviderId(value: string | null): value is ConnectorsLinkProviderId {
  return CONNECTORS_LINK_PROVIDER_IDS.some((id) => id === value);
}

/** The settings target for a Connectors deep link, or null for anything else. */
export function parseConnectorsSettingsLink(href: string): ConnectorsSettingsTarget | null {
  const trimmed = href.trim();
  if (!bareConnectorsLinkPattern.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const path = `${url.hostname}${url.pathname}`.toLowerCase().replace(/\/+$/, '');
  if (url.protocol !== 'kordi:' || path !== 'settings/connectors' || url.username || url.password) return null;
  const provider = url.searchParams.get('provider');
  return { tab: 'connectors', providerId: isProviderId(provider) ? provider : null };
}

export type ConnectorsLinkMatch = { href: string; label: string; matchedLength: number };

/** `[label](kordi://settings/connectors?...)` or a bare link at the start of `value`. */
export function connectorsSettingsLinkPrefix(value: string): ConnectorsLinkMatch | null {
  const markdown = value.match(/^\[([^\]\n]{1,200})\]\((kordi:\/\/settings\/connectors[^\s)]*)\)/i);
  if (markdown && parseConnectorsSettingsLink(markdown[2])) {
    return { href: markdown[2], label: markdown[1], matchedLength: markdown[0].length };
  }
  const bare = value.match(bareConnectorsLinkPattern)?.[0]?.replace(/[.,!?;:]+$/, '');
  if (bare && parseConnectorsSettingsLink(bare)) {
    return { href: bare, label: bare, matchedLength: bare.length };
  }
  return null;
}

let pendingProviderId: ConnectorsLinkProviderId | null = null;

/** The provider the last link asked for; cleared once read by the panel. */
export function takePendingConnectorsProvider(): ConnectorsLinkProviderId | null {
  const providerId = pendingProviderId;
  pendingProviderId = null;
  return providerId;
}

type LinkClickEvent = {
  preventDefault(): void;
  defaultPrevented?: boolean;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

function dispatchToWindow(target: ConnectorsSettingsTarget) {
  window.dispatchEvent(new CustomEvent<ConnectorsSettingsTarget>(CONNECTORS_SETTINGS_LINK_EVENT, { detail: target }));
}

/** Handles a click on a Connectors link. Returns true when it was handled. */
export function openConnectorsSettingsLink(
  event: LinkClickEvent,
  href: string,
  dispatch: (target: ConnectorsSettingsTarget) => void = dispatchToWindow,
) {
  const target = parseConnectorsSettingsLink(href);
  if (!target || event.defaultPrevented || (event.button ?? 0) !== 0) return false;
  event.preventDefault();
  dispatch(target);
  return true;
}

/** Applies a link target: remembers the provider and opens the dialog tab. */
export function applyConnectorsSettingsTarget(
  target: ConnectorsSettingsTarget,
  openDialogTab: (tab: ConnectorsSettingsTarget['tab']) => void,
) {
  pendingProviderId = target.providerId;
  openDialogTab(target.tab);
}

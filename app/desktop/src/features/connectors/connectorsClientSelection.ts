// Picks the connectors client for the signed-in account from the server's
// capabilities, the preview flag, and the shell.

import type { CloudAuthCapabilities } from '@/features/cloud/authClient';

import {
  connectorsClientForFlag,
  macLocalSourceFor,
  createDesktopMacLocalConnectorsClient,
  type ConnectorsClient,
  type DesktopInvoke,
} from './connectorsClient';
import { createCloudConnectorsClient, type CloudConnectorsApi } from './connectorsCloudClient';
import { connectorCatalog, type ConnectorProviderId, type ConnectorState } from './connectorsModel';

function hasDesktopShell(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

const desktopInvoke: DesktopInvoke = async <T,>(command: string, args?: Record<string, unknown>) => {
  const { invokeDesktop } = await import('@/lib/desktop');
  return invokeDesktop<T>(command, args);
};

export type ConnectorsClientSource = 'cloud' | 'preview' | 'mac_local';
/**
 * Whether the service rows can be shown: `checking` while the capabilities
 * load, `unreachable` when they failed, `unsupported` when the server has no
 * connectors support, and `ready` otherwise.
 */
export type ConnectorsServicesStatus = 'ready' | 'checking' | 'unreachable' | 'unsupported';
export type ConnectorsClientSelection = {
  client: ConnectorsClient;
  source: ConnectorsClientSource;
  servicesStatus: ConnectorsServicesStatus;
};
export type CloudCapabilitiesStatus = 'loading' | 'loaded' | 'failed';

export type ConnectorsClientForAccountOptions = {
  accountId: string;
  http: CloudConnectorsApi;
  capabilities: Pick<CloudAuthCapabilities, 'connectorsVersion'> | null | undefined;
  /** Defaults to `loaded`: only a loaded response without `connectorsVersion` means an older server. */
  capabilitiesStatus?: CloudCapabilitiesStatus;
  defaultAgentName?: string;
  /** Defaults to `VITE_KORDI_CONNECTORS_PREVIEW`. */
  previewFlag?: string;
  /** Defaults to whether this is the desktop shell. */
  desktopShell?: boolean;
  invoke?: DesktopInvoke;
};

function previewFlagFromEnv(): string | undefined {
  // `import.meta.env` is undefined outside Vite (for example under tsx tests).
  const flag: unknown = import.meta.env?.VITE_KORDI_CONNECTORS_PREVIEW;
  return typeof flag === 'string' ? flag : undefined;
}

export const SERVICE_CONNECTORS_NEED_NEWER_SERVER = 'Service connectors need a newer Kordi server.';
export const KORDI_CLOUD_UNREACHABLE = 'Could not reach Kordi Cloud.';
export const KORDI_CLOUD_CHECKING = 'Checking Kordi Cloud…';

function notConnected(providerId: ConnectorProviderId): ConnectorState {
  return {
    providerId,
    status: 'not_connected',
    connectedAt: null,
    grantedScopeIds: [],
    actEnabled: false,
    agentIds: [],
    lastEventAt: null,
  };
}

/**
 * Base for the Mac-local layer when the server has no connectors support:
 * every service row is not connected and nothing touches the network.
 */
export function createServicesUnavailableConnectorsClient(message = SERVICE_CONNECTORS_NEED_NEWER_SERVER): ConnectorsClient {
  const unavailable = (): Promise<never> => Promise.reject(new Error(message));
  return {
    list: () => Promise.resolve({
      states: connectorCatalog
        .filter((definition) => !macLocalSourceFor(definition.providerId))
        .map((definition) => notConnected(definition.providerId)),
      agents: [],
    }),
    connect: unavailable,
    grantAct: unavailable,
    setActEnabled: unavailable,
    setAgentGrant: unavailable,
    disconnect: unavailable,
    auditLog: () => Promise.resolve([]),
    recheckPermission: (providerId) => Promise.resolve(notConnected(providerId)),
  };
}

function macLocalOnlyBase(capabilitiesStatus: CloudCapabilitiesStatus): ConnectorsClientSelection {
  if (capabilitiesStatus === 'loading') {
    return { source: 'mac_local', servicesStatus: 'checking', client: createServicesUnavailableConnectorsClient(KORDI_CLOUD_CHECKING) };
  }
  if (capabilitiesStatus === 'failed') {
    return { source: 'mac_local', servicesStatus: 'unreachable', client: createServicesUnavailableConnectorsClient(KORDI_CLOUD_UNREACHABLE) };
  }
  return { source: 'mac_local', servicesStatus: 'unsupported', client: createServicesUnavailableConnectorsClient() };
}

/**
 * Picks the connectors client for the signed-in account, or null to hide the
 * section. A server that reports `connectorsVersion` gets the server-backed
 * client; otherwise `VITE_KORDI_CONNECTORS_PREVIEW=1` shows sample data. In
 * the desktop shell the Mac-local rows come from the Tauri commands, and the
 * section stays visible even without server support because those rows do
 * not need the server; while the capabilities load or after they fail, the
 * selection says so through `servicesStatus` so the panel can hide the
 * service rows instead of calling them disconnected.
 */
export function connectorsClientForAccount(options: ConnectorsClientForAccountOptions): ConnectorsClientSelection | null {
  const capabilitiesStatus = options.capabilitiesStatus ?? 'loaded';
  let services: ConnectorsClientSelection | null = null;
  if (capabilitiesStatus === 'loaded' && typeof options.capabilities?.connectorsVersion === 'number') {
    services = {
      source: 'cloud',
      servicesStatus: 'ready',
      client: createCloudConnectorsClient({
        accountId: options.accountId,
        http: options.http,
        defaultAgentName: options.defaultAgentName,
      }),
    };
  } else {
    const preview = connectorsClientForFlag(options.previewFlag ?? previewFlagFromEnv());
    if (preview) services = { source: 'preview', servicesStatus: 'ready', client: preview };
  }
  const desktopShell = options.desktopShell ?? hasDesktopShell();
  if (!desktopShell) return services;
  const base = services ?? macLocalOnlyBase(capabilitiesStatus);
  return {
    ...base,
    client: createDesktopMacLocalConnectorsClient(options.invoke ?? desktopInvoke, base.client),
  };
}

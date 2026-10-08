import {
  type ConnectorAgent,
  type ConnectorAuditEntry,
  type ConnectorProviderId,
  type ConnectorState,
} from './connectorsModel';
import { createPreviewConnectorsClient } from './connectorsPreviewClient';
import { createDesktopMacLocalConnectorsClient, type DesktopInvoke } from './connectorsMacLocalClient';

export { createPreviewConnectorsClient, type PreviewConnectorsClientOptions } from './connectorsPreviewClient';
export {
  createDesktopMacLocalConnectorsClient,
  macLocalConnectorState,
  macLocalConnectorStatus,
  macLocalSourceFor,
  type DesktopInvoke,
  type MacLocalConnectorsState,
  type MacLocalPermission,
  type MacLocalSource,
  type MacLocalSourceState,
} from './connectorsMacLocalClient';

export type ConnectorsClient = {
  list(): Promise<{ states: ConnectorState[]; agents: ConnectorAgent[] }>;
  connect(providerId: ConnectorProviderId, input: { scopeIds: string[] }): Promise<ConnectorState>;
  grantAct(providerId: ConnectorProviderId): Promise<ConnectorState>;
  setActEnabled(providerId: ConnectorProviderId, enabled: boolean): Promise<ConnectorState>;
  setAgentGrant(providerId: ConnectorProviderId, agentId: string, granted: boolean): Promise<ConnectorState>;
  disconnect(providerId: ConnectorProviderId): Promise<void>;
  auditLog(providerId: ConnectorProviderId): Promise<ConnectorAuditEntry[]>;
  recheckPermission(providerId: ConnectorProviderId): Promise<ConnectorState>;
  /**
   * False when no client backs the service rows, so the panel hides the
   * Services section. Omitted means available.
   */
  servicesAvailable?: boolean;
};

/** The environment's connectors client and whether it serves sample data. */
export type ConnectorsEnvironmentSelection = { client: ConnectorsClient; isPreview: boolean };

export function connectorsClientForFlag(flag: string | undefined): ConnectorsClient | null {
  return flag === '1' ? createPreviewConnectorsClient() : null;
}

function hasDesktopShell(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

/** True on macOS, from the webview's navigator (Tauri has no sync OS API here). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac/i.test(navigator.platform ?? '') || /Macintosh|Mac OS/i.test(navigator.userAgent ?? '');
}

function previewFlagFromEnv(): string | undefined {
  // `import.meta.env` is undefined outside Vite (for example under tsx tests).
  const flag: unknown = import.meta.env?.VITE_KORDI_CONNECTORS_PREVIEW;
  return typeof flag === 'string' ? flag : undefined;
}

const desktopInvoke: DesktopInvoke = async <T,>(command: string, args?: Record<string, unknown>) => {
  const { invokeDesktop } = await import('@/lib/desktop');
  return invokeDesktop<T>(command, args);
};

/**
 * Picks the connectors client for this build, or null to hide the section.
 * Only the macOS desktop shell gets the real Mac-local rows; there the
 * service rows keep the preview client (behind
 * `VITE_KORDI_CONNECTORS_PREVIEW=1`) until a server-backed client exists, and
 * without it the Services section is hidden. Elsewhere only the preview flag
 * shows the section.
 */
export function connectorsSelectionForEnvironment(
  flag: string | undefined = previewFlagFromEnv(),
  invoke: DesktopInvoke = desktopInvoke,
): ConnectorsEnvironmentSelection | null {
  const services = connectorsClientForFlag(flag);
  if (hasDesktopShell() && isMacPlatform()) {
    return { client: createDesktopMacLocalConnectorsClient(invoke, services), isPreview: services !== null };
  }
  return services ? { client: services, isPreview: true } : null;
}

export function connectorsClientForEnvironment(): ConnectorsClient | null {
  return connectorsSelectionForEnvironment()?.client ?? null;
}

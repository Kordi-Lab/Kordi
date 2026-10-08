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
  /** Aborting `signal` cancels a pending sign-in and rejects with a canceled error. */
  connect(providerId: ConnectorProviderId, input: { scopeIds: string[]; signal?: AbortSignal }): Promise<ConnectorState>;
  grantAct(providerId: ConnectorProviderId, options?: { signal?: AbortSignal }): Promise<ConnectorState>;
  setActEnabled(providerId: ConnectorProviderId, enabled: boolean): Promise<ConnectorState>;
  setAgentGrant(providerId: ConnectorProviderId, agentId: string, granted: boolean): Promise<ConnectorState>;
  disconnect(providerId: ConnectorProviderId): Promise<void>;
  auditLog(providerId: ConnectorProviderId): Promise<ConnectorAuditEntry[]>;
  recheckPermission(providerId: ConnectorProviderId): Promise<ConnectorState>;
};

export function connectorsClientForFlag(flag: string | undefined): ConnectorsClient | null {
  return flag === '1' ? createPreviewConnectorsClient() : null;
}

function hasDesktopShell(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

/**
 * Returns the connectors client for this build, or null to hide the section.
 * In the desktop shell the Mac-local rows are real; the service rows keep the
 * preview client (behind `VITE_KORDI_CONNECTORS_PREVIEW=1`) until a
 * server-backed client exists and the capabilities route reports
 * `connectorsVersion`.
 */
export function connectorsClientForEnvironment(): ConnectorsClient | null {
  // `import.meta.env` is undefined outside Vite (for example under tsx tests).
  const flag: unknown = import.meta.env?.VITE_KORDI_CONNECTORS_PREVIEW;
  const services = connectorsClientForFlag(typeof flag === 'string' ? flag : undefined);
  if (!hasDesktopShell()) return services;
  const invoke: DesktopInvoke = async <T,>(command: string, args?: Record<string, unknown>) => {
    const { invokeDesktop } = await import('@/lib/desktop');
    return invokeDesktop<T>(command, args);
  };
  return createDesktopMacLocalConnectorsClient(invoke, services);
}

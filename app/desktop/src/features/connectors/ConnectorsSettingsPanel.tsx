import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';

import { ConnectorDetailView } from './ConnectorDetailView';
import { ConnectorDialogs } from './ConnectorDialogs';
import type { ConnectorsClient } from './connectorsClient';
import type { ConnectorsServicesStatus } from './connectorsClientSelection';
import { isConnectorFlowCanceled, isConnectorGone } from './connectorsErrors';
import { ConnectorsPreviewNotice } from './ConnectorsPreviewNotice';
import {
  connectorCatalog,
  connectorDefinition,
  connectorListValue,
  hasGrantedActScopes,
  type ConnectorAgent,
  type ConnectorDefinition,
  type ConnectorProviderId,
  type ConnectorState,
} from './connectorsModel';
import { connectorIcons, denseNavRowsClass, macPermissionHelp, type ConnectorDialog } from './connectorsPanelConstants';
import { ConnectorBadge } from './connectorsPanelShared';

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

export function ConnectorsSettingsPanel({
  accountId,
  client,
  isNativeShell,
  isPreview = false,
  servicesStatus = 'ready',
  onRetryServices,
}: {
  accountId: string;
  client: ConnectorsClient;
  isNativeShell: boolean;
  /** True when `client` serves sample data rather than the account's connectors. */
  isPreview?: boolean;
  /** `checking` and `unreachable` replace the service rows with a status line. */
  servicesStatus?: ConnectorsServicesStatus;
  onRetryServices?: () => void;
}) {
  const [states, setStates] = useState<Partial<Record<ConnectorProviderId, ConnectorState>>>({});
  const [agents, setAgents] = useState<ConnectorAgent[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [selectedId, setSelectedId] = useState<ConnectorProviderId | null>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusIdRef = useRef<ConnectorProviderId | null>(null);
  const [busyProviderId, setBusyProviderId] = useState<ConnectorProviderId | null>(null);
  const [dialog, setDialog] = useState<ConnectorDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const idPrefix = useId();
  // Only the latest `list()` may update the panel, so a superseded client cannot.
  const listRequestRef = useRef(0);
  // The pending connect or act grant, aborted when the dialog closes.
  const flowRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    const request = ++listRequestRef.current;
    if (!quiet) setIsLoading(true);
    try {
      const result = await client.list();
      if (request !== listRequestRef.current) return;
      setStates(Object.fromEntries(result.states.map((state) => [state.providerId, state])));
      setAgents(result.agents);
      setHasLoaded(true);
      setError(null);
    } catch (caught) {
      if (request === listRequestRef.current) setError(errorMessage(caught, 'Could not load connectors.'));
    } finally {
      if (request === listRequestRef.current) setIsLoading(false);
    }
  }, [client]);

  useEffect(() => () => { flowRef.current?.abort(); }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    return () => { active = false; };
  }, [accountId, refresh]);

  useEffect(() => {
    if (selectedId) {
      backButtonRef.current?.focus();
      return;
    }
    const returnId = returnFocusIdRef.current;
    if (!returnId) return;
    returnFocusIdRef.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-connector-row="${returnId}"] button, button[data-connector-row="${returnId}"]`)?.focus();
  }, [selectedId]);

  const openDetail = (providerId: ConnectorProviderId) => {
    setError(null);
    setSelectedId(providerId);
  };

  const backToList = () => {
    returnFocusIdRef.current = selectedId;
    setSelectedId(null);
  };

  const applyState = (state: ConnectorState) => {
    setStates((current) => ({ ...current, [state.providerId]: state }));
  };

  const runRowAction = async (
    providerId: ConnectorProviderId,
    action: () => Promise<ConnectorState>,
    success: (state: ConnectorState) => string,
  ) => {
    setBusyProviderId(providerId);
    setError(null);
    try {
      const state = await action();
      applyState(state);
      setStatusMessage(success(state));
    } catch (caught) {
      setError(errorMessage(caught, 'Could not update this connector. Try again.'));
      if (isConnectorGone(caught)) void refresh({ quiet: true });
    } finally {
      setBusyProviderId(null);
    }
  };

  const closeDialog = () => {
    if (dialogBusy && !flowRef.current) return;
    flowRef.current?.abort();
    flowRef.current = null;
    setDialogBusy(false);
    setDialog(null);
  };

  /** Runs a connect or act grant that closing the dialog cancels. */
  const runFlow = async (
    definition: ConnectorDefinition,
    start: (signal: AbortSignal) => Promise<ConnectorState>,
    success: (state: ConnectorState) => string,
    failure: string,
  ) => {
    flowRef.current?.abort();
    const controller = new AbortController();
    flowRef.current = controller;
    setDialogBusy(true);
    setError(null);
    try {
      const state = await start(controller.signal);
      if (controller.signal.aborted) return;
      applyState(state);
      setStatusMessage(success(state));
      setDialog(null);
      void refresh({ quiet: true });
    } catch (caught) {
      if (controller.signal.aborted || isConnectorFlowCanceled(caught)) {
        setStatusMessage(`Connecting ${definition.name} was canceled.`);
        void refresh({ quiet: true });
        return;
      }
      setError(errorMessage(caught, failure));
      setDialog(null);
      if (isConnectorGone(caught)) void refresh({ quiet: true });
    } finally {
      if (flowRef.current === controller) {
        flowRef.current = null;
        setDialogBusy(false);
      }
    }
  };

  const openAudit = async (providerId: ConnectorProviderId) => {
    setDialog({ kind: 'audit', providerId, entries: null, error: null });
    try {
      const entries = await client.auditLog(providerId);
      setDialog((current) => (current?.kind === 'audit' && current.providerId === providerId
        ? { ...current, entries }
        : current));
    } catch (caught) {
      setDialog((current) => (current?.kind === 'audit' && current.providerId === providerId
        ? { ...current, entries: [], error: errorMessage(caught, 'Could not load activity.') }
        : current));
      if (isConnectorGone(caught)) void refresh({ quiet: true });
    }
  };

  const confirmConnect = (providerId: ConnectorProviderId) => {
    const definition = connectorDefinition(providerId);
    return runFlow(
      definition,
      (signal) => client.connect(providerId, { scopeIds: definition.readScopes.map((scope) => scope.id), signal }),
      (state) => (state.status === 'connected'
        ? `${definition.name} connected with read access.`
        : `${definition.name} needs one more permission.`),
      `Could not connect ${definition.name}.`,
    );
  };

  const confirmGrant = (providerId: ConnectorProviderId) => {
    const definition = connectorDefinition(providerId);
    return runFlow(
      definition,
      (signal) => client.grantAct(providerId, { signal }),
      (state) => (state.actEnabled && hasGrantedActScopes(definition, state)
        ? `Your agent can now act in ${definition.name}.`
        : `${definition.name} granted act access. Turn on acting to use it.`),
      `Could not grant act access to ${definition.name}.`,
    );
  };

  const confirmDisconnect = async (providerId: ConnectorProviderId) => {
    const definition = connectorDefinition(providerId);
    setDialogBusy(true);
    setError(null);
    try {
      await client.disconnect(providerId);
      setStatusMessage(`${definition.name} disconnected.`);
      setDialog(null);
      setSelectedId((current) => (current === providerId ? null : current));
      await refresh({ quiet: true });
    } catch (caught) {
      setError(errorMessage(caught, `Could not disconnect ${definition.name}.`));
      setDialog(null);
      if (isConnectorGone(caught)) {
        setSelectedId((current) => (current === providerId ? null : current));
        void refresh({ quiet: true });
      }
    } finally {
      setDialogBusy(false);
    }
  };

  const toggleAct = (definition: ConnectorDefinition, state: ConnectorState, enabled: boolean) => {
    if (enabled && definition.kind === 'service' && !hasGrantedActScopes(definition, state)) {
      setDialog({ kind: 'grant', providerId: definition.providerId });
      return;
    }
    void runRowAction(
      definition.providerId,
      () => client.setActEnabled(definition.providerId, enabled),
      () => (enabled ? `Your agent can act in ${definition.name}.` : `Your agent can only read from ${definition.name}.`),
    );
  };

  const setAgentGrant = (definition: ConnectorDefinition, agent: ConnectorAgent, granted: boolean) => {
    void runRowAction(
      definition.providerId,
      () => client.setAgentGrant(definition.providerId, agent.agentId, granted),
      () => (granted
        ? `${agent.name} can use ${definition.name}.`
        : `${agent.name} can no longer use ${definition.name}.`),
    );
  };

  const openSystemSettings = (definition: ConnectorDefinition) => {
    const url = macPermissionHelp[definition.providerId]?.settingsUrl;
    if (!isNativeShell || !url) return;
    void invoke('desktop_open_external_url', { url }).catch(() => {
      setError('Could not open System Settings.');
    });
  };

  const recheckPermission = (definition: ConnectorDefinition) => {
    void runRowAction(
      definition.providerId,
      () => client.recheckPermission(definition.providerId),
      (state) => (state.status === 'connected'
        ? `${definition.name} is connected.`
        : `${definition.name} ${macPermissionHelp[definition.providerId]?.stillNeeds ?? 'still needs permission'}.`),
    );
  };

  const primaryAction = (definition: ConnectorDefinition, state: ConnectorState | undefined) => {
    const busy = busyProviderId === definition.providerId;
    const status = state?.status ?? 'not_connected';
    if (definition.availability === 'coming_later' || status === 'connected') return null;
    if (status === 'needs_reauth') {
      return (
        <Button
          type="button"
          className="h-8 rounded-lg px-3.5 text-[12px]"
          aria-label={`Sign in to ${definition.name} again`}
          disabled={busy}
          onClick={() => setDialog({ kind: 'connect', providerId: definition.providerId, reauth: true })}
        >
          Sign in again
        </Button>
      );
    }
    if (status === 'permission_missing') {
      return (
        <>
          {isNativeShell && macPermissionHelp[definition.providerId] ? (
            <Button type="button" className="h-8 rounded-lg px-3.5 text-[12px]" disabled={busy} onClick={() => openSystemSettings(definition)}>
              Open System Settings
            </Button>
          ) : null}
          <Button
            type="button"
            variant="quiet"
            className="h-8 rounded-lg px-3.5 text-[12px]"
            aria-label={`Check ${definition.name} permission again`}
            disabled={busy}
            onClick={() => recheckPermission(definition)}
          >
            {busy ? 'Checking…' : 'Check again'}
          </Button>
        </>
      );
    }
    return (
      <Button
        type="button"
        className="h-8 rounded-lg px-3.5 text-[12px]"
        aria-label={`Connect ${definition.name}`}
        disabled={busy}
        onClick={() => setDialog({ kind: 'connect', providerId: definition.providerId, reauth: false })}
      >
        Connect
      </Button>
    );
  };

  const renderListRow = (definition: ConnectorDefinition) => {
    const state = states[definition.providerId];
    const Icon = connectorIcons[definition.providerId];
    const available = definition.availability === 'available';
    const value = connectorListValue(definition, state);
    return (
      <div key={definition.providerId} data-connector-row={definition.providerId}>
        <SettingsRow
          className="app-connector-row"
          icon={<Icon aria-hidden="true" className="h-[18px] w-[18px] text-white" />}
          title={(
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{definition.name}</span>
              <ConnectorBadge definition={definition} />
            </span>
          )}
          control={<span className="truncate text-[13px] font-normal text-slate-400">{value}</span>}
          chevron={available}
          ariaLabel={available ? `${definition.name}, ${value}` : undefined}
          onClick={available ? () => openDetail(definition.providerId) : undefined}
        />
      </div>
    );
  };

  const services = connectorCatalog.filter((definition) => definition.kind === 'service');
  const macLocal = connectorCatalog.filter((definition) => definition.kind === 'mac_local');
  const selectedDefinition = selectedId ? connectorDefinition(selectedId) : null;
  const servicesAvailable = client.servicesAvailable !== false;

  return (
    <div className="app-cloud-account-settings-section max-w-[760px]">
      {selectedDefinition ? null : (
      <SettingsSection
        title="Connectors"
        description={servicesAvailable
          ? 'Connect the services you use so your agent can read updates from them and, with your approval, act in them. Kordi keeps each sign-in on its servers and only shares results with your agent.'
          : 'Let your agent read sources on this Mac, with macOS permission. Results stay on this Mac.'}
      >
        <ConnectorsPreviewNotice show={isPreview} />
      </SettingsSection>
      )}

      <p className="sr-only" aria-live="polite">{statusMessage}</p>

      {error ? (
        <div className="app-error-text mt-4 flex items-center justify-between gap-3 rounded-[12px] bg-rose-500/10 px-3 py-2 text-[12px] leading-5 text-rose-100" role="alert">
          <span>{error}</span>
          {!hasLoaded ? (
            <Button type="button" variant="quiet" className="h-7 shrink-0 rounded-lg px-3 text-[12px]" disabled={isLoading} onClick={() => { void refresh(); }}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {!hasLoaded ? (
        isLoading ? (
          <div className="grid min-h-32 place-items-center text-[12px] text-slate-400" role="status">
            Loading connectors…
          </div>
        ) : null
      ) : selectedDefinition ? (
        <ConnectorDetailView
          definition={selectedDefinition}
          state={states[selectedDefinition.providerId]}
          agents={agents}
          busy={busyProviderId === selectedDefinition.providerId}
          backButtonRef={backButtonRef}
          primaryAction={primaryAction(selectedDefinition, states[selectedDefinition.providerId])}
          onBack={backToList}
          onToggleAct={(state, enabled) => toggleAct(selectedDefinition, state, enabled)}
          onSetAgentGrant={(agent, granted) => setAgentGrant(selectedDefinition, agent, granted)}
          onOpenAudit={() => { void openAudit(selectedDefinition.providerId); }}
          onDisconnect={() => setDialog({ kind: 'disconnect', providerId: selectedDefinition.providerId })}
        />
      ) : (
        <div ref={listRef} className={denseNavRowsClass}>
          {servicesAvailable ? (
            <SettingsSection title="Services" size="compact">
              {servicesStatus === 'checking' ? (
                <p className="m-0 py-2 text-[12px] text-slate-400" role="status">Checking Kordi Cloud…</p>
              ) : servicesStatus === 'unreachable' ? (
                <div className="flex items-center justify-between gap-3 py-2 text-[12px] text-slate-400" role="status">
                  <span>Could not reach Kordi Cloud.</span>
                  {onRetryServices ? (
                    <Button type="button" variant="quiet" className="h-7 shrink-0 rounded-lg px-3 text-[12px]" onClick={onRetryServices}>
                      Try again
                    </Button>
                  ) : null}
                </div>
              ) : services.map(renderListRow)}
            </SettingsSection>
          ) : null}
          {isNativeShell ? (
            <SettingsSection
              title="On this Mac"
              size="compact"
              description="These use macOS permissions and only run when your agent works on this Mac."
            >
              {macLocal.map(renderListRow)}
            </SettingsSection>
          ) : null}
        </div>
      )}

      <ConnectorDialogs
        dialog={dialog}
        dialogBusy={dialogBusy}
        idPrefix={idPrefix}
        onClose={closeDialog}
        onConfirmConnect={(providerId) => { void confirmConnect(providerId); }}
        onConfirmGrant={(providerId) => { void confirmGrant(providerId); }}
        onConfirmDisconnect={(providerId) => { void confirmDisconnect(providerId); }}
      />
    </div>
  );
}

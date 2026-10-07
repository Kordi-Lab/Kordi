import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  BellRing,
  Calendar,
  ChevronLeft,
  Contact,
  GitPullRequest,
  Hash,
  Mail,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';

import type { ConnectorsClient } from './connectorsClient';
import { ConnectorsPreviewNotice } from './ConnectorsPreviewNotice';
import {
  connectorCatalog,
  connectorDefinition,
  connectorListValue,
  connectorStatusLabel,
  disconnectConsequences,
  hasGrantedActScopes,
  type ConnectorAgent,
  type ConnectorAuditEntry,
  type ConnectorAuditOutcome,
  type ConnectorDefinition,
  type ConnectorProviderId,
  type ConnectorScope,
  type ConnectorState,
} from './connectorsModel';

const FULL_DISK_ACCESS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
const NOTIFICATION_CENTER_NOTE = 'Reads app name, title, text, and time for recent notifications on this Mac. Nothing from it is saved to lessons.';

const connectorIcons: Record<ConnectorProviderId, LucideIcon> = {
  google_calendar: Calendar,
  gmail: Mail,
  github: GitPullRequest,
  slack: Hash,
  outlook: Mail,
  mac_calendar: Calendar,
  mac_contacts: Contact,
  mac_notification_center: BellRing,
};

const outcomeLabels: Record<ConnectorAuditOutcome, string> = {
  completed: 'Completed',
  approved: 'Approved by you',
  denied: 'Denied by you',
  blocked_background: 'Background run, read only',
  failed: 'Failed',
};

const auditDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// AppDialog portals to document.body, outside `.kordi-app`, so the `.kordi-app.theme-light`
// slate remaps and `--utility-*` tokens do not reach dialog content. Dialogs use the
// body-scoped transient tokens instead.
const dialogText = 'text-[color:var(--app-transient-text)]';
const dialogMuted = 'text-[color:var(--app-transient-muted-text)]';
const dialogSubtle = 'text-[color:var(--app-transient-subtle-text)]';
const dialogDanger = 'text-[color:var(--app-transient-danger-text)]';

// Denser navigation rows (about 40px) than the shared SettingsRow default, applied
// from a wrapper so the shared component stays unchanged.
const denseNavRowsClass = '[&_.app-settings-row-button]:min-h-8 [&_.app-settings-row-button]:py-0.5 [&_.app-settings-row-button]:gap-2.5 [&_.app-settings-row:not(.app-settings-row-button)]:py-1 [&_.app-settings-section]:pt-4 [&_.app-settings-section:first-child]:pt-2';

const destructiveButtonClass = 'h-8 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3.5 text-[12px] text-rose-200 hover:bg-rose-500/15 hover:text-rose-100';

type ConnectorDialog =
  | { kind: 'connect'; providerId: ConnectorProviderId; reauth: boolean }
  | { kind: 'grant'; providerId: ConnectorProviderId }
  | { kind: 'audit'; providerId: ConnectorProviderId; entries: ConnectorAuditEntry[] | null; error: string | null }
  | { kind: 'disconnect'; providerId: ConnectorProviderId };

function auditTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const elapsed = Math.max(0, Date.now() - date.getTime());
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} min ago`;
  if (elapsed < 86_400_000) return `${Math.max(1, Math.floor(elapsed / 3_600_000))} hr ago`;
  return auditDateFormatter.format(date);
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

function ScopeChip({ scope }: { scope: ConnectorScope }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-4',
        scope.group === 'act' ? 'bg-amber-400/10 text-amber-100' : 'bg-white/[0.06] text-slate-300',
      )}
    >
      {scope.label}
    </span>
  );
}

function ScopeList({ scopes }: { scopes: ConnectorScope[] }) {
  return (
    <ul className="m-0 mt-3 grid list-none gap-1.5 p-0">
      {scopes.map((scope) => (
        <li key={scope.id} className={cn('flex items-start gap-2 text-[13px] leading-5', dialogText)}>
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--app-transient-subtle-text)]" />
          {scope.label}
        </li>
      ))}
    </ul>
  );
}

function Badge({ children, tone, inDialog = false }: { children: ReactNode; tone: 'amber' | 'muted'; inDialog?: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-medium',
        inDialog
          // Body-portaled dialogs: `body.theme-light` is set by the app shell.
          ? tone === 'amber'
            ? 'bg-amber-400/10 text-amber-100 [.theme-light_&]:bg-amber-500/15 [.theme-light_&]:text-amber-900'
            : 'bg-[color:var(--app-transient-raised-bg)] text-[color:var(--app-transient-muted-text)]'
          : tone === 'amber' ? 'bg-amber-400/10 text-amber-100' : 'bg-white/[0.06] text-slate-300',
      )}
    >
      {children}
    </span>
  );
}

export function ConnectorsSettingsPanel({
  accountId,
  client,
  isNativeShell, isPreview = false,
}: {
  accountId: string;
  client: ConnectorsClient;
  isNativeShell: boolean; isPreview?: boolean; // isPreview: `client` serves sample data.
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

  const refresh = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) setIsLoading(true);
    try {
      const result = await client.list();
      setStates(Object.fromEntries(result.states.map((state) => [state.providerId, state])));
      setAgents(result.agents);
      setHasLoaded(true);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not load connectors.'));
    } finally {
      setIsLoading(false);
    }
  }, [client]);

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
    } finally {
      setBusyProviderId(null);
    }
  };

  const closeDialog = () => {
    if (!dialogBusy) setDialog(null);
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
    }
  };

  const confirmConnect = async (providerId: ConnectorProviderId) => {
    const definition = connectorDefinition(providerId);
    setDialogBusy(true);
    setError(null);
    try {
      const state = await client.connect(providerId, { scopeIds: definition.readScopes.map((scope) => scope.id) });
      applyState(state);
      setStatusMessage(state.status === 'connected'
        ? `${definition.name} connected with read access.`
        : `${definition.name} needs one more permission.`);
      setDialog(null);
      void refresh({ quiet: true });
    } catch (caught) {
      setError(errorMessage(caught, `Could not connect ${definition.name}.`));
      setDialog(null);
    } finally {
      setDialogBusy(false);
    }
  };

  const confirmGrant = async (providerId: ConnectorProviderId) => {
    const definition = connectorDefinition(providerId);
    setDialogBusy(true);
    setError(null);
    try {
      applyState(await client.grantAct(providerId));
      setStatusMessage(`Your agent can now act in ${definition.name}.`);
      setDialog(null);
    } catch (caught) {
      setError(errorMessage(caught, `Could not grant act access to ${definition.name}.`));
      setDialog(null);
    } finally {
      setDialogBusy(false);
    }
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

  const openSystemSettings = () => {
    if (!isNativeShell) return;
    void invoke('desktop_open_external_url', { url: FULL_DISK_ACCESS_SETTINGS_URL }).catch(() => {
      setError('Could not open System Settings.');
    });
  };

  const recheckPermission = (definition: ConnectorDefinition) => {
    void runRowAction(
      definition.providerId,
      () => client.recheckPermission(definition.providerId),
      (state) => (state.status === 'connected'
        ? `${definition.name} is connected.`
        : `${definition.name} still needs Full Disk Access.`),
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
          {isNativeShell ? (
            <Button type="button" className="h-8 rounded-lg px-3.5 text-[12px]" disabled={busy} onClick={openSystemSettings}>
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

  const connectorBadge = (definition: ConnectorDefinition) => (
    definition.experimental ? <Badge tone="amber">Experimental</Badge> : null
  );

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
              {connectorBadge(definition)}
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

  const renderDetail = (definition: ConnectorDefinition) => {
    const state = states[definition.providerId];
    const Icon = connectorIcons[definition.providerId];
    const busy = busyProviderId === definition.providerId;
    const connected = state?.status === 'connected';
    const grantedRead = state ? definition.readScopes.filter((scope) => state.grantedScopeIds.includes(scope.id)) : [];
    const grantedAct = state ? definition.actScopes.filter((scope) => state.grantedScopeIds.includes(scope.id)) : [];
    return (
      <div>
        <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--app-divider)] pb-4">
          <Button
            ref={backButtonRef}
            type="button"
            variant="quiet"
            className="-ml-2 h-8 rounded-lg px-2.5 text-[12px]"
            onClick={backToList}
          >
            <ChevronLeft aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Back to connectors
          </Button>
          <span aria-hidden="true" className="h-4 w-px bg-[color:var(--app-divider)]" />
          <Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-white" />
          <h1 className="m-0 min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-white">{definition.name}</h1>
          {connectorBadge(definition)}
        </div>

        <SettingsSection className="pt-4">
          <SettingsRow
            title={connectorStatusLabel(definition, state, agents)}
            description={definition.experimental
              ? `${definition.summary} Experimental, read-only, best effort.`
              : definition.summary}
            control={primaryAction(definition, state)}
          />
          {definition.experimental ? (
            <SettingsRow title="What it reads" description={NOTIFICATION_CENTER_NOTE} />
          ) : null}
        </SettingsSection>

        {connected && state ? (
          <>
            <SettingsSection title="Access">
              <SettingsRow
                title="Allowed"
                description={(
                  <span className="mt-1.5 flex flex-wrap gap-1.5" aria-label={`${definition.name} access`}>
                    {(grantedRead.length > 0 ? grantedRead : definition.readScopes).map((scope) => <ScopeChip key={scope.id} scope={scope} />)}
                    {state.actEnabled ? grantedAct.map((scope) => <ScopeChip key={scope.id} scope={scope} />) : null}
                  </span>
                )}
              />
              {definition.actScopes.length > 0 ? (
                <SettingsRow
                  title="Let my agent act here"
                  description={state.actEnabled
                    ? `${definition.actDescription} Anything on your Ask me before list still waits for your approval.`
                    : `Your agent can only read from ${definition.name}.`}
                  control={(
                    <SettingsSwitch
                      enabled={state.actEnabled}
                      label={`Let my agent act in ${definition.name}`}
                      disabled={busy}
                      onChange={(enabled) => toggleAct(definition, state, enabled)}
                    />
                  )}
                />
              ) : null}
              <SettingsRow
                title="Background runs"
                description="Digests and scheduled work can only read. They never get act tools."
              />
            </SettingsSection>

            <SettingsSection title="Agents">
              {agents.map((agent) => (
                <SettingsRow
                  key={agent.agentId}
                  title={agent.name}
                  description={agent.isDefault ? 'Default agent' : undefined}
                  control={(
                    <SettingsSwitch
                      enabled={state.agentIds.includes(agent.agentId)}
                      label={`Let ${agent.name} use ${definition.name}`}
                      disabled={busy}
                      onChange={(granted) => {
                        void runRowAction(
                          definition.providerId,
                          () => client.setAgentGrant(definition.providerId, agent.agentId, granted),
                          () => (granted
                            ? `${agent.name} can use ${definition.name}.`
                            : `${agent.name} can no longer use ${definition.name}.`),
                        );
                      }}
                    />
                  )}
                />
              ))}
            </SettingsSection>

            <SettingsSection title="Activity" className={denseNavRowsClass}>
              <SettingsRow
                title="Activity log"
                description="Every read and act call is recorded."
                chevron
                ariaLabel={`${definition.name} activity log`}
                onClick={() => { void openAudit(definition.providerId); }}
              />
            </SettingsSection>

            <SettingsSection title="Remove">
              <SettingsRow
                title="Disconnect"
                description={`Removes the sign-in and stored events from ${definition.name}.`}
                control={(
                  <Button
                    type="button"
                    variant="secondary"
                    className={destructiveButtonClass}
                    aria-label={`Disconnect ${definition.name}`}
                    disabled={busy}
                    onClick={() => setDialog({ kind: 'disconnect', providerId: definition.providerId })}
                  >
                    Disconnect
                  </Button>
                )}
              />
            </SettingsSection>
          </>
        ) : null}
      </div>
    );
  };

  const services = connectorCatalog.filter((definition) => definition.kind === 'service');
  const macLocal = connectorCatalog.filter((definition) => definition.kind === 'mac_local');
  const dialogDefinition = dialog ? connectorDefinition(dialog.providerId) : null;
  const selectedDefinition = selectedId ? connectorDefinition(selectedId) : null;

  return (
    <div className="app-cloud-account-settings-section max-w-[760px]">
      {selectedDefinition ? null : (
      <SettingsSection
        title="Connectors"
        description="Connect the services you use so your agent can read updates from them and, with your approval, act in them. Kordi keeps each sign-in on its servers and only shares results with your agent."
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
        renderDetail(selectedDefinition)
      ) : (
        <div ref={listRef} className={denseNavRowsClass}>
          <SettingsSection title="Services" size="compact">
            {services.map(renderListRow)}
          </SettingsSection>
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

      {dialog?.kind === 'connect' && dialogDefinition ? (
        <AppDialog
          titleId={`${idPrefix}-connect-title`}
          descriptionId={`${idPrefix}-connect-description`}
          onDismiss={closeDialog}
          dismissDisabled={dialogBusy}
          busy={dialogBusy}
          className="max-w-md rounded-[20px]"
          backdropClassName="!z-[100000]"
        >
          {dialogDefinition.kind === 'service' ? (
            <>
              <AppDialogTitle id={`${idPrefix}-connect-title`}>
                {dialog.reauth ? `Sign in to ${dialogDefinition.name} again` : `Connect ${dialogDefinition.name}`}
              </AppDialogTitle>
              <AppDialogDescription id={`${idPrefix}-connect-description`}>
                Kordi asks {dialogDefinition.providerName} for read access only. You can let your agent act here later from this page.
              </AppDialogDescription>
            </>
          ) : (
            <>
              <AppDialogTitle id={`${idPrefix}-connect-title`}>Allow access to {dialogDefinition.name}</AppDialogTitle>
              <AppDialogDescription id={`${idPrefix}-connect-description`}>
                macOS will ask you to allow Kordi to read {dialogDefinition.name}. Your agent only sees results while it works on this Mac.
              </AppDialogDescription>
            </>
          )}
          <ScopeList scopes={dialogDefinition.readScopes} />
          {dialogBusy ? (
            <p className={cn('m-0 mt-4 text-[12px] leading-5', dialogMuted)} role="status">
              {dialogDefinition.kind === 'service' ? `Waiting for ${dialogDefinition.providerName}…` : 'Waiting for macOS…'}
            </p>
          ) : null}
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={dialogBusy} onClick={closeDialog}>Cancel</Button>
            <Button className="rounded-full px-4" disabled={dialogBusy} onClick={() => { void confirmConnect(dialog.providerId); }}>
              {dialogDefinition.kind === 'service' ? `Continue to ${dialogDefinition.providerName}` : 'Allow access'}
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}

      {dialog?.kind === 'grant' && dialogDefinition ? (
        <AppDialog
          titleId={`${idPrefix}-grant-title`}
          descriptionId={`${idPrefix}-grant-description`}
          onDismiss={closeDialog}
          dismissDisabled={dialogBusy}
          busy={dialogBusy}
          className="max-w-md rounded-[20px]"
          backdropClassName="!z-[100000]"
        >
          <AppDialogTitle id={`${idPrefix}-grant-title`}>Let your agent act in {dialogDefinition.name}</AppDialogTitle>
          <AppDialogDescription id={`${idPrefix}-grant-description`}>
            This is a second permission you grant on purpose. Your agent will be able to:
          </AppDialogDescription>
          <ScopeList scopes={dialogDefinition.actScopes} />
          <p className={cn('m-0 mt-3 text-[13px] leading-6', dialogMuted)}>
            It still asks you first for anything on your Ask me before list, and background runs never get these tools.
          </p>
          {dialogBusy && dialogDefinition.kind === 'service' ? (
            <p className={cn('m-0 mt-3 text-[12px] leading-5', dialogMuted)} role="status">
              Waiting for {dialogDefinition.providerName}…
            </p>
          ) : null}
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={dialogBusy} onClick={closeDialog}>Not now</Button>
            <Button className="rounded-full px-4" disabled={dialogBusy} onClick={() => { void confirmGrant(dialog.providerId); }}>
              {dialogDefinition.kind === 'service' ? `Continue to ${dialogDefinition.providerName}` : 'Allow'}
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}

      {dialog?.kind === 'audit' && dialogDefinition ? (
        <AppDialog
          titleId={`${idPrefix}-audit-title`}
          descriptionId={`${idPrefix}-audit-description`}
          onDismiss={closeDialog}
          className="max-w-lg rounded-[20px]"
          backdropClassName="!z-[100000]"
        >
          <AppDialogTitle id={`${idPrefix}-audit-title`}>{dialogDefinition.name} activity</AppDialogTitle>
          <AppDialogDescription id={`${idPrefix}-audit-description`}>
            Every read and act call your agents made, newest first.
          </AppDialogDescription>
          {dialog.error ? (
            <p className={cn('m-0 mt-3 text-[12px]', dialogDanger)} role="alert">{dialog.error}</p>
          ) : null}
          {dialog.entries === null ? (
            <p className={cn('m-0 mt-4 text-[12px]', dialogMuted)} role="status">Loading activity…</p>
          ) : dialog.entries.length === 0 ? (
            <p className={cn('m-0 mt-4 text-[12px]', dialogMuted)}>No activity yet.</p>
          ) : (
            <ol className="m-0 mt-4 max-h-[360px] list-none divide-y divide-[color:var(--app-transient-divider)] overflow-y-auto p-0">
              {dialog.entries.map((entry) => (
                <li key={entry.id} className="py-2.5">
                  <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]', dialogSubtle)}>
                    <time dateTime={entry.at}>{auditTimeLabel(entry.at)}</time>
                    <span aria-hidden="true">·</span>
                    <span>{entry.agentName}</span>
                    <code className={cn('font-mono text-[11px]', dialogMuted)}>{entry.tool}</code>
                    <Badge inDialog tone={entry.group === 'act' ? 'amber' : 'muted'}>{entry.group === 'act' ? 'Act' : 'Read'}</Badge>
                    <span className={cn(
                      'text-[11px]',
                      entry.outcome === 'denied' || entry.outcome === 'blocked_background' || entry.outcome === 'failed' ? dialogDanger : dialogMuted,
                    )}
                    >
                      {outcomeLabels[entry.outcome]}
                    </span>
                  </div>
                  <p className={cn('m-0 mt-1 text-[12px] leading-5', dialogText)}>{entry.summary}</p>
                </li>
              ))}
            </ol>
          )}
          <AppDialogActions>
            <Button className="rounded-full px-4" autoFocus onClick={closeDialog}>Done</Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}

      {dialog?.kind === 'disconnect' && dialogDefinition ? (
        <AppDialog
          titleId={`${idPrefix}-disconnect-title`}
          descriptionId={`${idPrefix}-disconnect-description`}
          onDismiss={closeDialog}
          dismissDisabled={dialogBusy}
          busy={dialogBusy}
          className="max-w-md rounded-[20px]"
          backdropClassName="!z-[100000]"
        >
          <AppDialogTitle id={`${idPrefix}-disconnect-title`}>Disconnect {dialogDefinition.name}?</AppDialogTitle>
          <AppDialogDescription id={`${idPrefix}-disconnect-description`}>
            {disconnectConsequences(dialogDefinition).map((line) => (
              <span key={line} className="block">{line}</span>
            ))}
          </AppDialogDescription>
          <AppDialogActions>
            <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={dialogBusy} onClick={closeDialog}>Cancel</Button>
            <Button className="rounded-full bg-rose-500 px-4 text-white hover:bg-rose-400" disabled={dialogBusy} onClick={() => { void confirmDisconnect(dialog.providerId); }}>
              {dialogBusy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}
    </div>
  );
}

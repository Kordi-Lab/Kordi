import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import {
  connectorDefinition,
  disconnectConsequences,
  type ConnectorAuditOutcome,
  type ConnectorProviderId,
  type ConnectorScope,
} from './connectorsModel';
import type { ConnectorDialog } from './connectorsPanelConstants';
import { Badge } from './connectorsPanelShared';

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

function auditTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const elapsed = Math.max(0, Date.now() - date.getTime());
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} min ago`;
  if (elapsed < 86_400_000) return `${Math.max(1, Math.floor(elapsed / 3_600_000))} hr ago`;
  return auditDateFormatter.format(date);
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

export function ConnectorDialogs({
  dialog,
  dialogBusy,
  idPrefix,
  onClose,
  onConfirmConnect,
  onConfirmGrant,
  onConfirmDisconnect,
}: {
  dialog: ConnectorDialog | null;
  dialogBusy: boolean;
  idPrefix: string;
  onClose: () => void;
  onConfirmConnect: (providerId: ConnectorProviderId) => void;
  onConfirmGrant: (providerId: ConnectorProviderId) => void;
  onConfirmDisconnect: (providerId: ConnectorProviderId) => void;
}) {
  const dialogDefinition = dialog ? connectorDefinition(dialog.providerId) : null;
  const closeDialog = onClose;

  return (
    <>
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
            <Button className="rounded-full px-4" disabled={dialogBusy} onClick={() => { onConfirmConnect(dialog.providerId); }}>
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
            <Button className="rounded-full px-4" disabled={dialogBusy} onClick={() => { onConfirmGrant(dialog.providerId); }}>
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
            <Button className="rounded-full bg-rose-500 px-4 text-white hover:bg-rose-400" disabled={dialogBusy} onClick={() => { onConfirmDisconnect(dialog.providerId); }}>
              {dialogBusy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </AppDialogActions>
        </AppDialog>
      ) : null}
    </>
  );
}

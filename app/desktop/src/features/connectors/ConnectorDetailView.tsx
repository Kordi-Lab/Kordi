import type { ReactNode, RefObject } from 'react';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';

import {
  connectorStatusLabel,
  type ConnectorAgent,
  type ConnectorDefinition,
  type ConnectorScope,
  type ConnectorState,
} from './connectorsModel';
import { connectorIcons, denseNavRowsClass } from './connectorsPanelConstants';
import { ConnectorBadge } from './connectorsPanelShared';

const NOTIFICATION_CENTER_NOTE = 'Reads app name, title, text, and time for recent notifications on this Mac. Nothing from it is saved to lessons.';

const destructiveButtonClass = 'h-8 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3.5 text-[12px] text-rose-200 hover:bg-rose-500/15 hover:text-rose-100';

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

export function ConnectorDetailView({
  definition,
  state,
  agents,
  busy,
  backButtonRef,
  primaryAction,
  onBack,
  onToggleAct,
  onSetAgentGrant,
  onOpenAudit,
  onDisconnect,
}: {
  definition: ConnectorDefinition;
  state: ConnectorState | undefined;
  agents: ConnectorAgent[];
  busy: boolean;
  backButtonRef: RefObject<HTMLButtonElement | null>;
  primaryAction: ReactNode;
  onBack: () => void;
  onToggleAct: (state: ConnectorState, enabled: boolean) => void;
  onSetAgentGrant: (agent: ConnectorAgent, granted: boolean) => void;
  onOpenAudit: () => void;
  onDisconnect: () => void;
}) {
  const Icon = connectorIcons[definition.providerId];
  const connected = state?.status === 'connected';
  const macLocal = definition.kind === 'mac_local';
  // A Mac source that is on can always be turned off, even without permission.
  const canDisconnect = connected || (macLocal && state?.enabled === true);
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
          onClick={onBack}
        >
          <ChevronLeft aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          Back to connectors
        </Button>
        <span aria-hidden="true" className="h-4 w-px bg-[color:var(--app-divider)]" />
        <Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-white" />
        <h1 className="m-0 min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-white">{definition.name}</h1>
        <ConnectorBadge definition={definition} />
      </div>

      <SettingsSection className="pt-4">
        <SettingsRow
          title={connectorStatusLabel(definition, state, agents)}
          description={definition.experimental
            ? `${definition.summary} Experimental, read-only, best effort.`
            : definition.summary}
          control={primaryAction}
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
            {definition.actScopes.length > 0 && !macLocal ? (
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
                    onChange={(enabled) => onToggleAct(state, enabled)}
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
            {macLocal ? <SettingsRow title="All agents on this Mac" /> : agents.map((agent) => (
              <SettingsRow
                key={agent.agentId}
                title={agent.name}
                description={agent.isDefault ? 'Default agent' : undefined}
                control={(
                  <SettingsSwitch
                    enabled={state.agentIds.includes(agent.agentId)}
                    label={`Let ${agent.name} use ${definition.name}`}
                    disabled={busy}
                    onChange={(granted) => onSetAgentGrant(agent, granted)}
                  />
                )}
              />
            ))}
          </SettingsSection>

          {macLocal ? null : (
            <SettingsSection title="Activity" className={denseNavRowsClass}>
              <SettingsRow
                title="Activity log"
                description="Every read and act call is recorded."
                chevron
                ariaLabel={`${definition.name} activity log`}
                onClick={onOpenAudit}
              />
            </SettingsSection>
          )}
        </>
      ) : null}

      {canDisconnect ? (
        <SettingsSection title="Remove">
          <SettingsRow
            title="Disconnect"
            description={macLocal
              ? `Stops reading ${definition.name} on this Mac.`
              : `Removes the sign-in and stored events from ${definition.name}.`}
            control={(
              <Button
                type="button"
                variant="secondary"
                className={destructiveButtonClass}
                aria-label={`Disconnect ${definition.name}`}
                disabled={busy}
                onClick={onDisconnect}
              >
                Disconnect
              </Button>
            )}
          />
        </SettingsSection>
      ) : null}
    </div>
  );
}

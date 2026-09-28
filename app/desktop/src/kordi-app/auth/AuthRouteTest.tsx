import { useState } from 'react';
import type { CloudProviderRouteTestInput, CloudProviderRouteTestResult } from '@/features/cloud/cloudAgentRuntimeTypes';
import { SettingsRow, SettingsSection, SettingsSelect } from '@/kordi-app/components/settingsLayout';
import { AuthActionButton, authButtonPrimaryClass } from './AuthDetailPrimitives';
import type { AuthDisplayProvider } from './model';
import { routeAccounts } from './authRouteAccounts';
import { providerShortName } from './providerCopy';

const thinkingOptions = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

type AuthRouteTestProps = {
  provider: AuthDisplayProvider;
  onTestRoute: (input: CloudProviderRouteTestInput) => Promise<CloudProviderRouteTestResult>;
  /** Why the test cannot run on this backend; the button stays off while set. */
  disabledReason?: string | null;
};

/** Provider, Account, Model and Thinking rows, then one explicit hosted test. */
export function AuthRouteTest({ provider, onTestRoute, disabledReason = null }: AuthRouteTestProps) {
  const [providerChoice, setProviderChoice] = useState('');
  const [routeChoice, setRouteChoice] = useState('');
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [thinking, setThinking] = useState('medium');
  const [routeTesting, setRouteTesting] = useState(false);
  const [routeResult, setRouteResult] = useState<CloudProviderRouteTestResult | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const accounts = routeAccounts(provider);
  const providerIds = [...new Set(accounts.map((account) => account.providerId))];
  const defaultAccount = accounts.find((option) => option.active) ?? accounts[0];
  const selectedProviderId = providerIds.includes(providerChoice) ? providerChoice : defaultAccount?.providerId ?? '';
  const providerAccounts = accounts.filter((account) => account.providerId === selectedProviderId);
  const account = providerAccounts.find((option) => option.value === routeChoice)
    ?? providerAccounts.find((option) => option.active) ?? providerAccounts[0];
  if (!account) return null;

  const routeModel = modelOverride ?? account.suggestedModel;
  const clearResult = () => { setRouteResult(null); setRouteError(null); };
  const chooseProvider = (value: string) => {
    setProviderChoice(value);
    setRouteChoice('');
    setModelOverride(null);
    clearResult();
  };
  const chooseAccount = (value: string) => {
    const next = accounts.find((option) => option.value === value);
    setRouteChoice(value);
    if (next && (next.modelHint || (modelOverride && next.modelIds.length && !next.modelIds.includes(modelOverride)))) {
      setModelOverride(null);
    }
    clearResult();
  };
  const providerName = (providerId: string) => providerShortName(provider.methods.find((method) => method.providerId === providerId)?.providerName ?? providerId);

  const runRouteTest = async () => {
    if (!routeModel.trim() || routeTesting) return;
    if (account.modelIds.length && !account.modelIds.includes(routeModel)) {
      setRouteError('Choose a model from this provider.');
      return;
    }
    setRouteTesting(true);
    clearResult();
    try {
      setRouteResult(await onTestRoute({
        provider: account.providerId, authChoice: account.value,
        model: `${account.providerId}/${routeModel.trim()}`, thinking,
      }));
    } catch (caught) {
      setRouteError(caught instanceof Error ? caught.message : 'Could not test this route.');
    } finally {
      setRouteTesting(false);
    }
  };

  return (
    <SettingsSection title="Test route" className="app-auth-detail-section">
      <SettingsRow
        title="Provider"
        description="The OMP provider that runs the test."
        control={(
          <SettingsSelect
            label="Provider"
            value={selectedProviderId}
            options={providerIds.map((id) => ({ value: id, label: providerName(id) }))}
            onChange={(event) => chooseProvider(event.target.value)}
          />
        )}
      />
      <SettingsRow
        title="Account"
        description="The saved account OMP signs in with."
        control={(
          <SettingsSelect
            label="Account"
            value={account.value}
            options={providerAccounts.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(event) => chooseAccount(event.target.value)}
          />
        )}
      />
      <SettingsRow
        title="Model"
        description="Models this provider offers through OMP."
        control={account.modelIds.length ? (
          <SettingsSelect
            label="Model"
            value={account.modelIds.includes(routeModel) ? routeModel : account.suggestedModel}
            options={account.modelIds.map((modelId) => ({ value: modelId, label: modelId }))}
            onChange={(event) => { setModelOverride(event.target.value); clearResult(); }}
          />
        ) : (
          <input
            aria-label="Model ID"
            placeholder="Model ID from your endpoint"
            className="app-input-shell app-flat-input h-8 w-[240px] rounded-lg px-3 text-[13px] text-white outline-none"
            value={routeModel}
            onChange={(event) => { setModelOverride(event.target.value); clearResult(); }}
          />
        )}
      />
      <SettingsRow
        title="Thinking"
        description="Reasoning effort for the test turn."
        control={<SettingsSelect label="Thinking" value={thinking} options={thinkingOptions} onChange={(event) => { setThinking(event.target.value); clearResult(); }} />}
      />
      <SettingsRow
        title="Run a test"
        description="Sends one short hosted request through OMP and may use provider quota."
        control={(
          <AuthActionButton type="button" className={authButtonPrimaryClass} title={disabledReason ?? undefined} disabled={Boolean(disabledReason) || routeTesting || !routeModel.trim()} onClick={() => { void runRouteTest(); }}>
            {routeTesting ? 'Testing…' : 'Test route'}
          </AuthActionButton>
        )}
      />
      {routeResult ? (
        <div role="status" className="py-3.5">
          <div className="text-[13px] font-medium text-white">{routeResult.runner} confirmed · {routeResult.accountLabel} · {routeResult.model}</div>
          <div className="mt-0.5 text-[12px] leading-5 text-slate-400">{routeResult.response}</div>
        </div>
      ) : null}
      {routeError && routeError !== disabledReason ? <div className="app-error-text py-3.5 text-[12px] text-rose-200" role="alert">{routeError}</div> : null}
    </SettingsSection>
  );
}

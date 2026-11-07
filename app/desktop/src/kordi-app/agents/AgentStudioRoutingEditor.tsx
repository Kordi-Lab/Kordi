import { useMemo, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { ErrorLine } from '@/components/ui/ErrorLine';
import type { ComposerModelOption, ComposerProviderOption } from '../components';
import type { AgentModelRoutingDraft } from './factoryAgentUtils';

function normalizedProvider(value?: string | null) {
  const normalized = value?.trim().toLocaleLowerCase().replace(/[\s_]+/g, '-') ?? '';
  if (['openai-codex', 'openai-api', 'openai-api-key', 'chatgpt', 'chatgpt-account'].includes(normalized)) return 'openai';
  if (['claude', 'claude-subscription', 'anthropic-api', 'anthropic-api-key'].includes(normalized)) return 'anthropic';
  return normalized;
}

function authChoice(option?: ComposerProviderOption) {
  if (!option?.value.includes('::')) return null;
  return option.value.split('::').slice(1).join('::') || null;
}

function modelLabel(option: ComposerModelOption) {
  return option.providerLabel ? `${option.label} · ${option.providerLabel}` : option.label;
}

export function AgentStudioRoutingEditor({
  routing,
  modelOptions,
  providerOptions,
  onSave,
  onClose,
}: {
  routing: AgentModelRoutingDraft;
  modelOptions: ComposerModelOption[];
  providerOptions: ComposerProviderOption[];
  onSave: (values: AgentModelRoutingDraft) => Promise<void> | void;
  onClose: () => void;
}) {
  const [defaultModel, setDefaultModel] = useState(routing.defaultModel || modelOptions[0]?.value || '');
  const [accountChoice, setAccountChoice] = useState(routing.defaultAuthChoice || '');
  const [fallbackModel, setFallbackModel] = useState(routing.fallbackModel || '');
  const [thinking, setThinking] = useState(routing.thinking || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const defaultOption = modelOptions.find((option) => option.value === defaultModel);
  const primaryProvider = normalizedProvider(defaultOption?.provider ?? defaultModel.split('/')[0]);
  const primaryAccounts = providerOptions.filter((option) => normalizedProvider(option.providerId) === primaryProvider);
  const thinkingLevels = useMemo(
    () => defaultOption?.thinkingLevels?.length ? defaultOption.thinkingLevels : ['off', 'medium', 'high'],
    [defaultOption?.thinkingLevels],
  );

  const resolveAuth = (modelValue: string, currentProvider?: string | null, currentChoice?: string | null) => {
    if (!modelValue) return { provider: null, choice: null };
    const model = modelOptions.find((option) => option.value === modelValue);
    const provider = normalizedProvider(model?.provider ?? modelValue.split('/')[0]);
    if (provider && currentChoice?.trim() && normalizedProvider(currentProvider) === provider) {
      return { provider: currentProvider ?? provider, choice: currentChoice ?? null };
    }
    const accounts = providerOptions.filter((option) => !option.disabled && !option.unavailable && normalizedProvider(option.providerId) === provider);
    const auth = accounts.find((option) => option.active) ?? (accounts.length === 1 ? accounts[0] : undefined);
    return { provider: auth?.providerId ?? model?.provider ?? (provider || null), choice: authChoice(auth) };
  };

  const save = async () => {
    if (!defaultModel || saving) return;
    setSaving(true);
    setError('');
    const selectedAccount = primaryAccounts.find((option) => authChoice(option) === accountChoice);
    const defaultAuth = selectedAccount
      ? { provider: selectedAccount.providerId, choice: accountChoice }
      : resolveAuth(defaultModel, routing.defaultAuthProvider, accountChoice);
    const fallbackAuth = resolveAuth(fallbackModel, routing.fallbackAuthProvider, routing.fallbackAuthChoice);
    try {
      await onSave({
        defaultModel,
        defaultAuthProvider: defaultAuth.provider,
        defaultAuthChoice: defaultAuth.choice,
        fallbackModel: fallbackModel || null,
        fallbackAuthProvider: fallbackAuth.provider,
        fallbackAuthChoice: fallbackAuth.choice,
        thinking: thinking || null,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Kordi could not save this model route.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="app-agent-studio-popover" role="dialog" aria-modal="false" aria-label="Edit model routing">
      <div className="app-agent-studio-popover-head">
        <strong>Model routing</strong>
        <button type="button" className="app-button-quiet app-agent-studio-icon-button" aria-label="Close model routing" onClick={onClose}><X className="h-4 w-4" /></button>
      </div>
      <label className="app-agent-studio-field">
        <span>Default model</span>
        <select value={defaultModel} onChange={(event) => {
          const model = modelOptions.find((option) => option.value === event.currentTarget.value);
          if (normalizedProvider(model?.provider) !== primaryProvider) setAccountChoice('');
          setDefaultModel(event.currentTarget.value);
        }}>
          {modelOptions.map((option) => <option key={option.value} value={option.value}>{modelLabel(option)}</option>)}
        </select>
      </label>
      <label className="app-agent-studio-field">
        <span>Provider account</span>
        <select value={accountChoice} onChange={(event) => setAccountChoice(event.currentTarget.value)}>
          <option value="">Active account</option>
          {accountChoice && !primaryAccounts.some((option) => authChoice(option) === accountChoice)
            ? <option value={accountChoice}>Account unavailable</option> : null}
          {primaryAccounts.map((option) => <option key={option.value} value={authChoice(option) ?? ''} disabled={option.disabled || option.unavailable}>{option.label}</option>)}
        </select>
      </label>
      <label className="app-agent-studio-field">
        <span>Fallback model</span>
        <select value={fallbackModel} onChange={(event) => setFallbackModel(event.currentTarget.value)}>
          <option value="">No fallback</option>
          {modelOptions.map((option) => <option key={option.value} value={option.value}>{modelLabel(option)}</option>)}
        </select>
      </label>
      <label className="app-agent-studio-field">
        <span>Thinking level</span>
        <select value={thinking} onChange={(event) => setThinking(event.currentTarget.value)}>
          <option value="">Model default</option>
          {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      {error ? <ErrorLine className="mt-0">{error}</ErrorLine> : null}
      <div className="app-agent-studio-popover-actions">
        <button type="button" className="app-button-quiet app-agent-studio-button is-ghost is-small" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="app-button-quiet app-agent-studio-button is-primary is-small" onClick={() => void save()} disabled={saving || !defaultModel}>
          {saving ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Saving</> : 'Save routing'}
        </button>
      </div>
    </section>
  );
}

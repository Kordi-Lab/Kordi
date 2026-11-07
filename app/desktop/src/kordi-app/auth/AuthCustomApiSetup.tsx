import { useState } from 'react';
import { ErrorLine } from '@/components/ui/ErrorLine';
import type { CloudProviderAuthSnapshotInput } from '@/features/cloud/cloudAgentRuntimeTypes';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';
import { AuthActionButton, authButtonPrimaryClass } from './AuthDetailPrimitives';
import { CUSTOM_MODEL_MAX_LENGTH, customModelIdError, type CustomApiAccount } from './customApiAccount';

const inputClass = 'app-input-shell app-flat-input h-8 w-[260px] max-w-full rounded-lg px-3 text-[13px] text-white outline-none placeholder:text-slate-500';

function validCustomBaseUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local')
      && !host.endsWith('.internal') && !/^[\d.]+$/.test(host) && !host.includes(':');
  } catch {
    return false;
  }
}

type FieldError = { field: 'baseUrl' | 'model' | 'save'; message: string };

type AuthCustomApiSetupProps = {
  /** Why keys cannot be verified on this backend; Save stays off while set. */
  disabledReason?: string | null;
  /** An existing account to change; saving re-publishes it under the same choice. */
  account?: CustomApiAccount | null;
  onValidateCloudKey?: (providerId: string, apiKey: string) => Promise<{ verified: boolean }>;
  onSaveCloudKey?: (input: CloudProviderAuthSnapshotInput) => Promise<void>;
  /** The account is saved; the owner returns to the provider page with it. */
  onSaved?: (authChoice: string, options: { edited: boolean }) => void;
};

function fieldError(error: FieldError | null, field: FieldError['field'], disabledReason: string | null) {
  return error && error.field === field && error.message !== disabledReason ? error.message : null;
}

/** Kordi-only OpenAI-compatible endpoint; OMP has no catalog entry for it, so the account names its model. */
export function AuthCustomApiSetup({ account = null, onValidateCloudKey, onSaveCloudKey, onSaved, disabledReason = null }: AuthCustomApiSetupProps) {
  const [label, setLabel] = useState(account?.label ?? '');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState(account?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<FieldError | null>(null);
  const baseUrlError = fieldError(error, 'baseUrl', disabledReason);
  const modelError = fieldError(error, 'model', disabledReason);
  const saveError = fieldError(error, 'save', disabledReason);
  // Save stays off until the base URL, model ID and key are all entered.
  const complete = Boolean(baseUrl.trim() && model.trim() && apiKey.trim());

  const save = async () => {
    if (saving || !complete || !onSaveCloudKey) return;
    if (!validCustomBaseUrl(baseUrl.trim())) {
      setError({ field: 'baseUrl', message: 'Enter a public HTTPS base URL.' });
      return;
    }
    const modelIdError = customModelIdError(model);
    if (modelIdError) {
      setError({ field: 'model', message: modelIdError });
      return;
    }
    setSaving(true);
    setError(null);
    const authChoice = account?.authChoice ?? `cloud-api-key:${crypto.randomUUID()}`;
    try {
      await onValidateCloudKey?.('custom', apiKey.trim());
      await onSaveCloudKey({
        provider: 'custom',
        authChoice,
        label: label.trim() || 'Work',
        payload: { apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), model: model.trim() },
      });
      setApiKey('');
      onSaved?.(authChoice, { edited: Boolean(account) });
    } catch (caught) {
      setError({ field: 'save', message: caught instanceof Error ? caught.message : 'Could not save this key.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title={account ? 'Edit account' : 'Add account'}
      description={account
        ? 'Saving replaces this account, so enter its base URL and key again.'
        : 'Use a public HTTPS endpoint with an OpenAI-compatible Chat Completions API.'}
      className="app-auth-detail-section"
    >
      <SettingsRow
        title="Account name"
        description="Shown when you choose this account"
        control={<input aria-label="Account name" placeholder="Work" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} className={inputClass} />}
      />
      <SettingsRow
        title="Base URL"
        description={<>The endpoint root, ending before /chat/completions.{baseUrlError ? <ErrorLine>{baseUrlError}</ErrorLine> : null}</>}
        control={<input aria-label="API base URL" placeholder="https://api.example.com/v1" value={baseUrl} aria-invalid={baseUrlError ? true : undefined} onChange={(event) => setBaseUrl(event.target.value)} className={cn(inputClass, baseUrlError && 'app-flat-input-error')} />}
      />
      <SettingsRow
        title="Model ID"
        description={<>The model name your endpoint serves, sent as the Chat Completions model field.{modelError ? <ErrorLine>{modelError}</ErrorLine> : null}</>}
        control={<input aria-label="Model ID" placeholder="deepseek-chat" maxLength={CUSTOM_MODEL_MAX_LENGTH} value={model} aria-invalid={modelError ? true : undefined} onChange={(event) => setModel(event.target.value)} className={cn(inputClass, modelError && 'app-flat-input-error')} />}
      />
      <SettingsRow
        title="API key"
        description={saveError ? <ErrorLine className="mt-0">{saveError}</ErrorLine> : 'Stored in your Kordi account for hosted agents.'}
        control={(
          <>
            <input aria-label="API key" type="password" autoComplete="off" placeholder="API key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className={inputClass} />
            {/* A new key after an error lets a corrected form save at once, past the double-press guard. */}
            <AuthActionButton key={error ? 'save-retry' : 'save'} type="button" className={authButtonPrimaryClass} title={disabledReason ?? undefined} disabled={Boolean(disabledReason) || saving || !complete} onClick={() => { void save(); }}>
              {saving ? 'Saving…' : 'Save key'}
            </AuthActionButton>
          </>
        )}
      />
    </SettingsSection>
  );
}

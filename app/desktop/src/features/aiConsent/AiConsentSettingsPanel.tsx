import { ArrowUpRight } from 'lucide-react';
import { useMemo } from 'react';

import { KORDI_PRIVACY_URL, KORDI_TERMS_URL } from '@/kordi-app/cloud/CloudLoginLegalLine';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { openDesktopExternalUrl } from '@/lib/desktop';

import { createAiConsentClient, type AiConsentClient } from './aiConsentClient';
import { saveAiConsent, useAiConsentState } from './aiConsentStore';

export const AI_SHARING_LABEL = 'Share with AI models';
export const AI_SHARING_CAPTION = 'OpenAI and Google process what agents work on.';

function openLink(url: string) {
  void openDesktopExternalUrl(url).catch(() => undefined);
}

const linkIcon = <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-500" />;

/** Settings › Privacy: the account's AI consent and the legal pages. */
export function AiConsentSettingsPanel({ client }: { client?: AiConsentClient }) {
  const consentClient = useMemo(() => client ?? createAiConsentClient(), [client]);
  const consent = useAiConsentState();
  // A server without AI consent has nothing to switch; the legal links still show.
  const known = consent.accountId !== null && consent.status !== null;
  const inlineError = consent.prompt === null ? consent.error : null;
  return (
    <div className="app-cloud-account-settings-section max-w-[680px]">
      <SettingsSection title="Privacy">
        {known ? (
          <SettingsRow
            title={AI_SHARING_LABEL}
            description={<span aria-live="polite">{inlineError ?? AI_SHARING_CAPTION}</span>}
            control={(
              <SettingsSwitch
                enabled={consent.status === 'allowed'}
                label={AI_SHARING_LABEL}
                disabled={consent.saving}
                onChange={(enabled) => { void saveAiConsent(enabled ? 'allowed' : 'declined', consentClient); }}
              />
            )}
          />
        ) : null}
        <SettingsRow title="Privacy policy" onClick={() => openLink(KORDI_PRIVACY_URL)} control={linkIcon} />
        <SettingsRow title="Terms of service" onClick={() => openLink(KORDI_TERMS_URL)} control={linkIcon} />
      </SettingsSection>
    </div>
  );
}

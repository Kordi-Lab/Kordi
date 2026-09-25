import { useEffect, useState } from 'react';
import { CompactComposerModelMenu } from '@/kordi-app/components/composer';
import { isRouteAccountUnavailable, type ComposerProviderOption } from '@/kordi-app/components/composerModelSelection';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';
import { AuthActionButton, authButtonPrimaryClass } from '@/kordi-app/auth/AuthDetailPrimitives';
import { loadPinnedOmpCatalog, type OmpCatalogEntry } from '@/kordi-app/auth/ompCatalog';
import { hostedModelOptions, hostedProviderOptions, hostedRouteAccounts, hostedRouteForChoice } from '@/features/chat/hostedComposerOptions';
import { routeRunsOnKordiCloud } from '@/features/cloud/cloudAgentRuntimeRoute';
import type { CloudProviderAuthSnapshot } from '@/features/cloud/cloudAgentRuntimeTypes';
import { hostedAccountsFromSnapshots } from '@/features/cloud/hostedAccounts';
import { ACCOUNT_UNAVAILABLE_LABEL } from '@/features/cloud/routeAccountChoice';
import { KordiCloudRuntimeCaptionView } from '@/pages/chatsPage.kordiCloudCaption';
import type { DesktopAuthProvider } from '@/kordi-app/types';

type Route = { model: string; thinking: string; authProvider: string | null; authChoice: string | null };

/**
 * Preview-only agent session using the real composer route menu and send
 * gate: a route that names a removed account shows "Account unavailable", and
 * the hosted accounts of the Kordi account are listed to run on Kordi Cloud.
 */
export function PreviewSessionRoute({ providers, initialAuthChoice, loadSnapshots }: {
  providers: DesktopAuthProvider[];
  initialAuthChoice: string;
  loadSnapshots: () => Promise<CloudProviderAuthSnapshot[]>;
}) {
  const [route, setRoute] = useState<Route>({
    model: 'openai-codex/gpt-5.5', thinking: 'medium', authProvider: 'openai-codex', authChoice: initialAuthChoice,
  });
  const [hosted, setHosted] = useState<{ snapshots: CloudProviderAuthSnapshot[]; catalog: OmpCatalogEntry[] }>({ snapshots: [], catalog: [] });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadSnapshots(), loadPinnedOmpCatalog()]).then(([snapshots, catalog]) => {
      if (!cancelled) setHosted({ snapshots, catalog: catalog.providers });
    });
    return () => { cancelled = true; };
  }, [loadSnapshots]);
  const localChoices = new Set(providers.flatMap((provider) => provider.options.map((option) => option.value)));
  const hostedAccounts = hostedRouteAccounts(hostedAccountsFromSnapshots(hosted.snapshots), hosted.catalog, localChoices);
  const providerOptions: ComposerProviderOption[] = [
    ...providers
      .filter((provider) => provider.id === 'openai-codex' || provider.id === 'openai')
      .flatMap((provider) => provider.options.map((option) => ({
        value: `${provider.id}::${option.value}`,
        providerId: provider.id,
        label: provider.id === 'openai-codex' ? 'ChatGPT' : 'OpenAI',
        detail: option.label,
        active: option.active,
      }))),
    ...hostedProviderOptions(hostedAccounts, routeRunsOnKordiCloud(route) ? route.authChoice : null),
  ];
  const modelOptions = [
    { value: 'openai-codex/gpt-5.5', label: 'gpt-5.5', provider: 'openai-codex' },
    { value: 'openai/gpt-5.5', label: 'gpt-5.5', provider: 'openai' },
    ...hostedModelOptions(hostedAccounts),
  ];
  const unavailable = isRouteAccountUnavailable(route, providerOptions);
  const onCloud = routeRunsOnKordiCloud(route);

  return (
    <SettingsSection title="Agent session" className="mb-6">
      <SettingsRow
        title="Route"
        description={unavailable
          ? <span role="status" className="text-amber-200">{ACCOUNT_UNAVAILABLE_LABEL}. Choose another account to continue.</span>
          : `The session runs with the account chosen here${onCloud ? `: ${route.model} on ${route.authChoice}` : ''}.`}
        control={(
          <>
            <KordiCloudRuntimeCaptionView show={onCloud} />
            <CompactComposerModelMenu
              scope="chat"
              selection={{ mode: 'agent', ...route }}
              providerOptions={providerOptions}
              modelOptions={modelOptions}
              onSave={({ providerOption, model, thinking }) => {
                const authChoice = providerOption?.value.split('::').slice(1).join('::') ?? null;
                const account = hostedAccounts.find((item) => item.authChoice === authChoice);
                // A hosted account applies its Kordi Cloud route, as Start chat does.
                const cloudRoute = account ? hostedRouteForChoice(account, { model, thinking, catalog: hosted.catalog }) : null;
                setRoute(cloudRoute
                  ? { model: cloudRoute.model ?? model, thinking, authProvider: cloudRoute.authProvider ?? null, authChoice: cloudRoute.authChoice ?? null }
                  : { model, thinking, authProvider: providerOption?.providerId ?? null, authChoice });
              }}
            />
          </>
        )}
      />
      <SettingsRow
        title="Send and test"
        description="Both stay off until the session names an account this device has."
        control={(
          <>
            <AuthActionButton type="button" className={authButtonPrimaryClass} disabled={unavailable}>Test route</AuthActionButton>
            <AuthActionButton type="button" className={authButtonPrimaryClass} disabled={unavailable}>Send</AuthActionButton>
          </>
        )}
      />
    </SettingsSection>
  );
}

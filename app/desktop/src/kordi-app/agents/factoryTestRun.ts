import type { CloudAuthClient } from '@/features/cloud/authClient';
import { hasHostedOnlyPrefix } from '@/features/cloud/routeAccountChoice';
import { claimRuntimeRoute } from '@/features/digest/digestMacRuns';
import type { DesktopAgentBuilderDraft, DesktopAgentBuilderStatus, DesktopChatMessageRoute } from '@/lib/desktop';
import type { ComposerProviderOption } from '../components';

function providerFamily(value: string | null | undefined) {
  const provider = value?.trim().toLowerCase() ?? '';
  if (['openai', 'openai-codex', 'chatgpt', 'openai-api'].includes(provider)) return 'openai';
  if (['anthropic', 'claude', 'claude-subscription'].includes(provider)) return 'anthropic';
  return provider;
}

/** Older drafts did not save an account choice. Resolve only within their provider. */
export function factoryDraftWithAccount(draft: DesktopAgentBuilderDraft, options: ComposerProviderOption[]): DesktopAgentBuilderDraft {
  if (draft.authChoice?.trim()) return draft;
  const provider = providerFamily(draft.provider || draft.model?.split('/')[0]);
  const matching = options.filter((option) => !option.disabled && !option.unavailable && providerFamily(option.providerId) === provider);
  const selected = matching.find((option) => option.active) ?? (matching.length === 1 ? matching[0] : undefined);
  if (!selected) {
    if (matching.length > 1) throw new Error('Choose an active account for this provider in Settings > Providers, then test the draft again.');
    return draft;
  }
  const authChoice = selected.value.split('::').slice(1).join('::');
  return authChoice ? { ...draft, provider: selected.providerId, authChoice } : draft;
}

type Lease = { runId: string; claimId: string };
type Claim = { acquired?: boolean; runId?: string; message?: string };

/** Hosted tests use their own owner-only lease; the native runtime never saves its credentials. */
export async function runFactoryDraftTest({ draft, session, client, invoke, isCurrent = () => true, renewMs = 20_000 }: {
  draft: DesktopAgentBuilderDraft;
  session: () => Promise<{ token: string } | null>;
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  invoke: (lease?: Lease) => Promise<DesktopAgentBuilderStatus>;
  isCurrent?: () => boolean;
  renewMs?: number;
}): Promise<DesktopAgentBuilderStatus> {
  const assertCurrent = () => { if (!isCurrent()) throw new Error('The active Factory draft changed. Test the selected draft again.'); };
  assertCurrent();
  if (!hasHostedOnlyPrefix(draft.authChoice)) return invoke();
  const signedIn = await session();
  assertCurrent();
  if (!signedIn) throw new Error('Sign in to Kordi to test this hosted provider account.');
  const route: DesktopChatMessageRoute = {
    model: draft.model, thinking: draft.thinking, authProvider: draft.provider, authChoice: draft.authChoice,
  };
  const claimId = crypto.randomUUID();
  let claim: Claim;
  try {
    claim = await client.desktopAgentExecution<Claim>(signedIn.token, 'tasks', {
      kind: 'factory_test', claimId, runtimeRoute: claimRuntimeRoute(route),
    });
  } catch {
    throw new Error('The Factory test could not start. Check your connection and that this server supports hosted Factory tests, then retry.');
  }
  const runId = claim.runId?.trim();
  if (!claim.acquired || !runId) throw new Error(claim.message || 'Another Factory test is running. Wait for it to finish, then retry.');
  const path = encodeURIComponent(runId);
  let passed = false;
  const timer = setInterval(() => {
    void client.desktopAgentExecution(signedIn.token, `${path}/renew`, { claimId }).catch(() => undefined);
  }, renewMs);
  try {
    assertCurrent();
    const result = await invoke({ runId, claimId });
    passed = result.testReport?.passed === true;
    return result;
  } finally {
    clearInterval(timer);
    // The native command completes the lease before persisting a passing report.
    if (!passed) await client.desktopAgentExecution(signedIn.token, `${path}/release`, { claimId }).catch(() => undefined);
  }
}

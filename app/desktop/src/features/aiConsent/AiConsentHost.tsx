import { useEffect, useMemo, useRef } from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';

import { createAiConsentClient, type AiConsentClient } from './aiConsentClient';
import { AiConsentPromptDialog, AiModelsOffDialog } from './AiConsentDialogs';
import {
  applyAiConsent,
  dismissAiConsentPrompt,
  getAiConsentState,
  noteAiConsentUserInput,
  openAiConsentPrompt,
  resetAiConsent,
  saveAiConsent,
  useAiConsentState,
} from './aiConsentStore';

/**
 * Keeps the AI consent store on the signed-in account and shows its prompts.
 * The consent prompt opens once after sign-in while no choice is saved.
 */
export function AiConsentHost({ account, client }: { account: CloudAccount | null; client?: AiConsentClient }) {
  const consentClient = useMemo(() => client ?? createAiConsentClient(), [client]);
  const state = useAiConsentState();
  const accountId = account?.accountId ?? null;
  const reported = account?.aiConsent?.status;
  const promptedAccountRef = useRef<string | null>(null);

  useEffect(() => {
    if (!accountId) {
      resetAiConsent();
      return;
    }
    if (reported) {
      applyAiConsent(accountId, reported);
      return;
    }
    // `/auth/me` without the field: ask the consent route directly; older servers have none.
    if (getAiConsentState().accountId !== accountId) applyAiConsent(accountId, null);
    let cancelled = false;
    consentClient.get().then(
      (consent) => { if (!cancelled) applyAiConsent(accountId, consent.status); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [accountId, consentClient, reported]);

  useEffect(() => {
    if (!accountId || state.accountId !== accountId || state.status !== 'unset') return;
    if (promptedAccountRef.current === accountId) return;
    promptedAccountRef.current = accountId;
    openAiConsentPrompt();
  }, [accountId, state.accountId, state.status]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const note = () => noteAiConsentUserInput();
    document.addEventListener('pointerdown', note, true);
    document.addEventListener('keydown', note, true);
    return () => {
      document.removeEventListener('pointerdown', note, true);
      document.removeEventListener('keydown', note, true);
    };
  }, []);

  if (!accountId || state.accountId !== accountId) return null;
  const allow = () => { void saveAiConsent('allowed', consentClient); };
  if (state.prompt === 'consent') {
    return (
      <AiConsentPromptDialog
        saving={state.saving}
        error={state.error}
        onAllow={allow}
        onDecline={() => { void saveAiConsent('declined', consentClient); }}
        onDismiss={dismissAiConsentPrompt}
      />
    );
  }
  if (state.prompt === 'off') {
    return <AiModelsOffDialog saving={state.saving} error={state.error} onAllow={allow} onDismiss={dismissAiConsentPrompt} />;
  }
  return null;
}

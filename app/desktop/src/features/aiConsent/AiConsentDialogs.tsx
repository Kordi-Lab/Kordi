import type { MouseEvent } from 'react';

import { Button } from '@/components/ui/button';
import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { KORDI_PRIVACY_URL } from './legalLinks';
import { openDesktopExternalUrl } from '@/lib/desktop';
import { cn } from '@/lib/utils';

// AppDialog portals to document.body, outside `.kordi-app`, so these dialogs
// use the body-scoped transient tokens rather than `--utility-*` or slate.
const dialogText = 'text-[color:var(--app-transient-text)]';
const dialogMuted = 'text-[color:var(--app-transient-muted-text)]';
const dialogDanger = 'text-[color:var(--app-transient-danger-text)]';

export const AI_CONSENT_TITLE = 'Kordi uses AI models';
export const AI_CONSENT_BODY = 'Agents, the System agent, Digest and Grounding send the messages, files and calendar details they work on to AI providers such as OpenAI, Anthropic and Google.';
export const AI_MODELS_OFF_TITLE = 'AI models are off';
export const AI_MODELS_OFF_BODY = 'Allow in Settings › Privacy to use agents.';

function openPrivacyPolicy(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  void openDesktopExternalUrl(KORDI_PRIVACY_URL).catch(() => undefined);
}

type DialogProps = {
  saving: boolean;
  error: string | null;
  onAllow: () => void;
  onDismiss: () => void;
};

function SaveError({ error }: { error: string | null }) {
  return error ? <p className={cn('m-0 mt-3 text-[12px] leading-5', dialogDanger)} role="alert">{error}</p> : null;
}

/** Asked once after sign-in, and before an AI action while no choice is saved. */
export function AiConsentPromptDialog({ saving, error, onAllow, onDismiss, onDecline }: DialogProps & { onDecline: () => void }) {
  return (
    <AppDialog
      titleId="ai-consent-title"
      descriptionId="ai-consent-description"
      onDismiss={onDismiss}
      dismissDisabled={saving}
      busy={saving}
      className="max-w-md rounded-[20px]"
      backdropClassName="!z-[100000]"
    >
      <AppDialogTitle id="ai-consent-title" className={dialogText}>{AI_CONSENT_TITLE}</AppDialogTitle>
      <AppDialogDescription id="ai-consent-description" className={dialogMuted}>{AI_CONSENT_BODY}</AppDialogDescription>
      <p className="m-0 mt-2 text-[13px] leading-6">
        <a href={KORDI_PRIVACY_URL} onClick={openPrivacyPolicy} className={cn('underline underline-offset-2', dialogText)}>Privacy policy</a>
      </p>
      <SaveError error={error} />
      <AppDialogActions>
        <Button variant="quiet" className="rounded-full px-4" disabled={saving} onClick={onDecline}>Don&apos;t allow</Button>
        <Button className="rounded-full px-4" autoFocus disabled={saving} onClick={onAllow}>Allow</Button>
      </AppDialogActions>
    </AppDialog>
  );
}

/** Shown when the person tries an AI action after declining. */
export function AiModelsOffDialog({ saving, error, onAllow, onDismiss }: DialogProps) {
  return (
    <AppDialog
      titleId="ai-models-off-title"
      descriptionId="ai-models-off-description"
      onDismiss={onDismiss}
      dismissDisabled={saving}
      busy={saving}
      className="max-w-sm rounded-[20px]"
      backdropClassName="!z-[100000]"
    >
      <AppDialogTitle id="ai-models-off-title" className={dialogText}>{AI_MODELS_OFF_TITLE}</AppDialogTitle>
      <AppDialogDescription id="ai-models-off-description" className={dialogMuted}>{AI_MODELS_OFF_BODY}</AppDialogDescription>
      <SaveError error={error} />
      <AppDialogActions>
        <Button variant="quiet" className="rounded-full px-4" autoFocus disabled={saving} onClick={onDismiss}>Cancel</Button>
        <Button className="rounded-full px-4" disabled={saving} onClick={onAllow}>Allow</Button>
      </AppDialogActions>
    </AppDialog>
  );
}

import { useId, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { CloudAuthError } from '@/features/cloud/cloudAuthError';
import type {
  CloudAccountEmailVerificationInput,
  CloudSignupCodeChallenge,
} from '@/features/cloud/signupEmailTypes';
import { SettingsRow } from '@/kordi-app/components';
import { cn } from '@/lib/utils';

import { cloudLoginErrorMessage } from './cloudLoginMessages';
import { CloudSignupVerificationFields } from './CloudSignupVerificationFields';
import { useCloudSignupVerification } from './useCloudSignupVerification';

export type CloudAccountEmailRowProps = {
  email: string;
  /** Undefined when the server predates email verification; the row is hidden then. */
  verified: boolean | undefined;
  onRequestCode?: () => Promise<CloudSignupCodeChallenge>;
  onVerify?: (input: CloudAccountEmailVerificationInput) => Promise<void>;
  /** Refreshes the account when the server reports the email as already verified. */
  onAlreadyVerified?: () => Promise<void>;
};

function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof CloudAuthError) return cloudLoginErrorMessage(caught, false);
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

function isAlreadyVerified(caught: unknown): boolean {
  return caught instanceof CloudAuthError && caught.code === 'email_already_verified';
}

export function CloudAccountEmailRow({
  email, verified, onRequestCode, onVerify, onAlreadyVerified,
}: CloudAccountEmailRowProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const errorId = useId();
  const {
    challenge, verificationCode, setVerificationCode, resendSeconds, sendCode, resetVerification,
  } = useCloudSignupVerification(email, onRequestCode ? () => onRequestCode() : undefined);

  if (verified === undefined) return null;

  const canVerify = Boolean(onRequestCode && onVerify);
  const isEnteringCode = !verified && challenge !== null;

  const handleAlreadyVerified = async (caught: unknown) => {
    resetVerification();
    setError(null);
    setNotice(errorText(caught, 'This email is already verified.'));
    try {
      await onAlreadyVerified?.();
    } catch {
      // The periodic profile refresh catches up if this reload fails.
    }
  };

  const requestCode = async () => {
    if (busy || !canVerify) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await sendCode();
    } catch (caught) {
      if (isAlreadyVerified(caught)) await handleAlreadyVerified(caught);
      else setError(errorText(caught, 'Could not send verification code.'));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !challenge || !onVerify || !/^\d{6}$/.test(verificationCode)) return;
    setBusy(true);
    setError(null);
    try {
      await onVerify({ verificationId: challenge.verificationId, verificationCode });
      resetVerification();
      setNotice('Email verified.');
    } catch (caught) {
      if (isAlreadyVerified(caught)) await handleAlreadyVerified(caught);
      else setError(errorText(caught, 'Could not verify email.'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    resetVerification();
    setError(null);
  };

  const status = verified
    ? <span className="text-[12px] font-medium text-emerald-300">Verified</span>
    : <span className="text-[12px] font-medium text-amber-200">Not verified</span>;

  const description = error
    ? <span id={errorId} className="app-error-text text-rose-200" aria-live="polite">{error}</span>
    : notice
      ? <span role="status">{notice}</span>
      : undefined;

  return (
    <SettingsRow
      title="Email"
      description={description}
      control={(
        <>
          <span className="max-w-[220px] truncate text-[13px] text-slate-300" title={email}>{email}</span>
          {status}
          {!verified && canVerify && !isEnteringCode ? (
            <Button
              type="button"
              variant="secondary"
              className="h-8 rounded-lg px-3.5 text-[12px]"
              disabled={busy || resendSeconds > 0}
              onClick={() => { void requestCode(); }}
            >
              {busy ? 'Sending code…' : resendSeconds > 0 ? `Verify email (${resendSeconds}s)` : 'Verify email'}
            </Button>
          ) : null}
        </>
      )}
    >
      {isEnteringCode ? (
        <form className="grid gap-3" onSubmit={(event) => { void submitCode(event); }}>
          <CloudSignupVerificationFields
            email={email}
            busy={busy}
            resendSeconds={resendSeconds}
            onResend={() => { void requestCode(); }}
            onChangeEmail={cancel}
            changeEmailLabel="Cancel"
          >
            <div className="flex items-center gap-2">
              <input
                aria-label="Email verification code"
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                value={verificationCode}
                disabled={busy}
                onChange={(event) => {
                  setVerificationCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6));
                  if (error) setError(null);
                }}
                className={cn(
                  'app-input-shell app-flat-input h-10 w-full min-w-0 rounded-[10px] px-3 text-[13px] font-normal text-white outline-none',
                  error && 'app-flat-input-error',
                )}
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error ? errorId : undefined}
              />
              <Button
                type="submit"
                className="h-10 shrink-0 rounded-lg px-3.5 text-[12px]"
                disabled={busy || !/^\d{6}$/.test(verificationCode)}
              >
                {busy ? 'Verifying…' : 'Verify'}
              </Button>
            </div>
          </CloudSignupVerificationFields>
        </form>
      ) : null}
    </SettingsRow>
  );
}

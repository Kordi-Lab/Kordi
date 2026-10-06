import type { ReactNode } from 'react';

export function CloudSignupVerificationFields({
  email, busy, resendSeconds, onResend, onChangeEmail, changeEmailLabel = 'Change email', children,
}: {
  email: string;
  busy: boolean;
  resendSeconds: number;
  onResend: () => void;
  onChangeEmail: () => void;
  changeEmailLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 text-[12px] font-medium tracking-[-0.005em]">
      <p role="status" className="text-muted-foreground">
        Enter the 6-digit code sent to {email}. It expires in 10 minutes. Check your spam folder too.
      </p>
      {children}
      <div className="flex justify-between">
        <button type="button" disabled={busy || resendSeconds > 0} onClick={onResend}>
          {resendSeconds > 0 ? `Resend in ${resendSeconds}s` : 'Resend code'}
        </button>
        <button type="button" disabled={busy} onClick={onChangeEmail}>{changeEmailLabel}</button>
      </div>
    </div>
  );
}

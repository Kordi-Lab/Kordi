import { useEffect, useState } from 'react';
import type { CloudSignupCodeChallenge } from '@/features/cloud/signupEmailTypes';

export function useCloudSignupVerification(
  email: string,
  requestCode?: (email: string) => Promise<CloudSignupCodeChallenge>,
) {
  const [challenge, setChallenge] = useState<CloudSignupCodeChallenge | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (!challenge) return;
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge]);

  async function sendCode() {
    if (!requestCode) throw new Error('Email verification is unavailable. Try Google or GitHub.');
    const next = await requestCode(email.trim());
    setChallenge(next);
    setVerificationCode('');
    setClockNow(Date.now());
    setResendAt(Date.now() + next.retryAfterSeconds * 1000);
  }

  function resetVerification() {
    setChallenge(null);
    setVerificationCode('');
  }

  return {
    challenge, verificationCode, setVerificationCode, sendCode, resetVerification,
    resendSeconds: Math.max(0, Math.ceil((resendAt - clockNow) / 1000)),
  };
}

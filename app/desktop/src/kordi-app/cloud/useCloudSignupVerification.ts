import { useEffect, useState } from 'react';
import { CloudAuthError } from '@/features/cloud/cloudAuthError';
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
    // Keep counting after a reset so callers can hold back a new request until the cooldown ends.
    if (!challenge && resendAt <= Date.now()) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setClockNow(now);
      if (!challenge && now >= resendAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [challenge, resendAt]);

  async function sendCode() {
    if (!requestCode) throw new Error('Email verification is unavailable. Try Google or GitHub.');
    let next: CloudSignupCodeChallenge;
    try {
      next = await requestCode(email.trim());
    } catch (caught) {
      // A cooldown answer arms the same countdown a sent code would, so the
      // resend action waits instead of hitting the limit again.
      if (caught instanceof CloudAuthError && caught.code === 'rate_limited' && caught.retryAfterSeconds) {
        const now = Date.now();
        setClockNow(now);
        setResendAt(now + caught.retryAfterSeconds * 1000);
      }
      throw caught;
    }
    setChallenge(next);
    setVerificationCode('');
    setClockNow(Date.now());
    setResendAt(Date.now() + next.retryAfterSeconds * 1000);
  }

  function resetVerification() {
    setChallenge(null);
    setVerificationCode('');
    setClockNow(Date.now());
  }

  return {
    challenge, verificationCode, setVerificationCode, sendCode, resetVerification,
    resendSeconds: Math.max(0, Math.ceil((resendAt - clockNow) / 1000)),
  };
}

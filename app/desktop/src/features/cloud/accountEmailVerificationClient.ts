import type { CloudAccountEmailVerificationInput, CloudSignupCodeChallenge } from './signupEmailTypes';

/** The request primitive shared by the cloud clients, as exposed by CloudAuthClient. */
export type CloudAccountEmailRequester = {
  request<TResponse>(path: string, init: RequestInit, fallbackMessage: string): Promise<TResponse>;
};

/** Sends a six-digit code to the signed-in account's primary email. */
export function requestAccountEmailCode(
  client: CloudAccountEmailRequester,
  token: string,
): Promise<CloudSignupCodeChallenge> {
  return client.request<CloudSignupCodeChallenge>(
    '/v1/cloud/auth/email/verification/code',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    },
    'Could not send verification code.',
  );
}

/** Consumes a code and marks the signed-in account's primary email verified. */
export async function verifyAccountEmail(
  client: CloudAccountEmailRequester,
  token: string,
  input: CloudAccountEmailVerificationInput,
): Promise<void> {
  await client.request<void>(
    '/v1/cloud/auth/email/verification',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        verificationId: input.verificationId,
        verificationCode: input.verificationCode,
      }),
    },
    'Could not verify email.',
  );
}

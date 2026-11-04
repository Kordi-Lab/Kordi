// PKCE (RFC 7636) and `state` values for browser sign-in.

/** 48 random bytes encode to a 64-character verifier, inside the 43–128 range. */
const VERIFIER_BYTES = 48;
const STATE_BYTES = 32;

type CryptoSource = Pick<Crypto, 'getRandomValues' | 'subtle'>;

export type PkcePair = { verifier: string; challenge: string };

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomUrlSafeString(byteLength: number, source: CryptoSource = globalThis.crypto): string {
  const bytes = new Uint8Array(byteLength);
  source.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function s256CodeChallenge(verifier: string, source: CryptoSource = globalThis.crypto): Promise<string> {
  const digest = await source.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function createPkcePair(source: CryptoSource = globalThis.crypto): Promise<PkcePair> {
  const verifier = randomUrlSafeString(VERIFIER_BYTES, source);
  return { verifier, challenge: await s256CodeChallenge(verifier, source) };
}

export function createSignInState(source: CryptoSource = globalThis.crypto): string {
  return randomUrlSafeString(STATE_BYTES, source);
}

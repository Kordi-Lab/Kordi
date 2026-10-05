import type { CloudAuthResult } from './authClient';

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character: string) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export type CloudOAuthHashError = {
  code: string | null;
  message: string;
};

/** Reads the error the server attached to an OAuth callback fragment, if any. */
export function parseCloudOAuthHashError(hash: string | null | undefined): CloudOAuthHashError | null {
  const trimmed = hash?.trim() ?? '';
  if (!trimmed.startsWith('#')) return null;
  const params = new URLSearchParams(trimmed.slice(1));
  const message = params.get('kordi_cloud_oauth_error')?.trim();
  if (!message) return null;
  const code = params.get('kordi_cloud_oauth_error_code')?.trim() || null;
  return { code, message };
}

export function parseCloudOAuthHashResult(hash: string | null | undefined): CloudAuthResult | null {
  const trimmed = hash?.trim() ?? '';
  if (!trimmed.startsWith('#')) return null;
  const params = new URLSearchParams(trimmed.slice(1));
  const encoded = params.get('kordi_cloud_oauth');
  if (!encoded) return null;
  const parsed = decodeBase64UrlJson<CloudAuthResult>(encoded);
  if (!parsed?.account?.accountId || !parsed.session?.token || !parsed.session?.expiresAt) return null;
  return parsed;
}

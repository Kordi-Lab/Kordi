import type { CloudOAuthProvider } from './authClient';

export const DEFAULT_CLOUD_API_BASE_URL = 'https://kordi.ai';
const LEGACY_PRODUCTION_CLOUD_API_BASE_URL = 'https://coordinar.io';
const PRODUCTION_CLOUD_API_HOSTNAMES = new Set(['kordi.ai', 'coordinar.io']);
const APPROVED_OPERATOR_CLOUD_API_ORIGINS = new Set([
  DEFAULT_CLOUD_API_BASE_URL,
  LEGACY_PRODUCTION_CLOUD_API_BASE_URL,
]);

export type CloudApiEnvironment = {
  DEV?: boolean;
  VITE_KORDI_CLOUD_API_BASE?: string;
  VITE_KORDI_DEV_PROFILE?: string;
  VITE_KORDI_PRODUCTION_DEBUG_ACK?: string;
};

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function isProductionCloudOrigin(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.+$/, '');
    return PRODUCTION_CLOUD_API_HOSTNAMES.has(hostname);
  } catch {
    return value === DEFAULT_CLOUD_API_BASE_URL;
  }
}

function operatorProductionDebugIsEnabled(env: CloudApiEnvironment | undefined): boolean {
  return env?.VITE_KORDI_DEV_PROFILE?.trim().toLowerCase() === 'operator'
    && env?.VITE_KORDI_PRODUCTION_DEBUG_ACK?.trim() === '1';
}

export function operatorCloudOAuthProviderFallback(
  env?: CloudApiEnvironment,
): CloudOAuthProvider[] {
  const meta = typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: CloudApiEnvironment }).env
    : undefined;
  const activeEnv = env ?? meta;
  const configured = activeEnv?.VITE_KORDI_CLOUD_API_BASE?.trim();
  if (!activeEnv?.DEV
    || !configured
    || !operatorProductionDebugIsEnabled(activeEnv)
    || !isProductionCloudOrigin(cleanBaseUrl(configured))) {
    return [];
  }
  return ['google', 'github'];
}

export function cloudApiBaseUrl(env?: CloudApiEnvironment): string {
  const meta = typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: CloudApiEnvironment }).env
    : undefined;
  const activeEnv = env ?? meta;
  const configured = activeEnv?.VITE_KORDI_CLOUD_API_BASE?.trim();

  if (activeEnv?.DEV) {
    if (!configured) {
      throw new Error('VITE_KORDI_CLOUD_API_BASE is required for development.');
    }
    const cleaned = cleanBaseUrl(configured);
    const operatorProfile = activeEnv.VITE_KORDI_DEV_PROFILE?.trim().toLowerCase() === 'operator';
    if (operatorProfile) {
      if (!operatorProductionDebugIsEnabled(activeEnv)) {
        throw new Error(
          'Production Cloud API is blocked in development until the operator acknowledgement is set.',
        );
      }
      if (!APPROVED_OPERATOR_CLOUD_API_ORIGINS.has(cleaned)) {
        throw new Error(
          'Operator development may use only the approved https://kordi.ai or '
          + 'https://coordinar.io product origin.',
        );
      }
      return cleaned;
    }
    if (isProductionCloudOrigin(cleaned)) {
      throw new Error(
        'Production Cloud API is blocked in development for community profiles. '
        + 'Use the allowlisted operator launcher for approved production debugging.',
      );
    }
    return cleaned;
  }

  if (configured) return cleanBaseUrl(configured);
  return DEFAULT_CLOUD_API_BASE_URL;
}

export function cloudRealtimeWebSocketEnabled(baseUrl = cloudApiBaseUrl()): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
  } catch {
    return true;
  }
}

export function cloudWebSocketUrl(token: string, baseUrl = cloudApiBaseUrl()): string {
  const url = new URL('/v1/cloud/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

export function chatSyncWebSocketUrl(ticket: string, baseUrl = cloudApiBaseUrl()): string {
  const url = new URL('/v2/chat/realtime', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}

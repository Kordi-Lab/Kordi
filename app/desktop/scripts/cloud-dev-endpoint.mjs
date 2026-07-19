export const PRODUCTION_CLOUD_API_ORIGIN = 'https://coordinar.io';
export const COMMUNITY_CLOUD_DEV_PROFILE = 'community';
export const OPERATOR_CLOUD_DEV_PROFILE = 'operator';
const PRODUCTION_CLOUD_API_HOSTNAME = new URL(PRODUCTION_CLOUD_API_ORIGIN).hostname;

function normalizeHostname(value) {
  return value.toLowerCase().replace(/\.+$/, '');
}

function isProductionCloudApiUrl(url) {
  return normalizeHostname(url.hostname) === PRODUCTION_CLOUD_API_HOSTNAME;
}

export function resolveCloudDevProfile(env = process.env) {
  const profile = typeof env?.VITE_KORDI_DEV_PROFILE === 'string'
    ? env.VITE_KORDI_DEV_PROFILE.trim().toLowerCase()
    : '';
  if (!profile || profile === COMMUNITY_CLOUD_DEV_PROFILE) return COMMUNITY_CLOUD_DEV_PROFILE;
  if (profile === OPERATOR_CLOUD_DEV_PROFILE) return OPERATOR_CLOUD_DEV_PROFILE;
  throw new Error('VITE_KORDI_DEV_PROFILE must be community or operator.');
}

export function operatorProductionDebugIsAllowed(env = process.env) {
  return resolveCloudDevProfile(env) === OPERATOR_CLOUD_DEV_PROFILE
    && env?.VITE_KORDI_PRODUCTION_DEBUG_ACK?.trim() === '1';
}

export function normalizeCloudApiOrigin(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error(
      'VITE_KORDI_CLOUD_API_BASE is required for development. '
      + 'Start the local debug server with `pnpm debug:cloud:up`, then set its loopback URL.',
    );
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('VITE_KORDI_CLOUD_API_BASE must be a valid absolute HTTP(S) URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('VITE_KORDI_CLOUD_API_BASE must use http:// or https://.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'VITE_KORDI_CLOUD_API_BASE must not include credentials, a query, or a fragment.',
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('VITE_KORDI_CLOUD_API_BASE must be an origin without a path.');
  }

  return url.origin;
}

export function resolveCloudDevApiBase(env = process.env) {
  const origin = normalizeCloudApiOrigin(env?.VITE_KORDI_CLOUD_API_BASE);
  if (isProductionCloudApiUrl(new URL(origin)) && !operatorProductionDebugIsAllowed(env)) {
    throw new Error(
      'Production Cloud API is blocked in development for community profiles. '
      + 'Use the allowlisted operator launcher for approved production debugging.',
    );
  }
  return origin;
}

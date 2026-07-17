export const PRODUCTION_CLOUD_API_ORIGIN = 'https://coordinar.io';

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
  if (origin === PRODUCTION_CLOUD_API_ORIGIN) {
    throw new Error(
      'Production Cloud API is blocked in development. '
      + 'Use the self-hosted debug server or an approved non-production environment.',
    );
  }
  return origin;
}

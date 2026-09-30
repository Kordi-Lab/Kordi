import {
  OPERATOR_CLOUD_DEV_PROFILE,
  resolveCloudDevApiBase,
  resolveCloudDevProfile,
} from './cloud-dev-endpoint.mjs';

const DEVELOPMENT_DESKTOP_ICONS = [
  'icons/icon-dev.png',
  'icons/icon-dev.icns',
];
const PRODUCT_DESKTOP_ICONS = [
  'icons/icon.png',
  'icons/icon.icns',
];

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function resolveDesktopPreviewIcons(env = process.env) {
  return resolveCloudDevProfile(env) === OPERATOR_CLOUD_DEV_PROFILE
    ? PRODUCT_DESKTOP_ICONS
    : DEVELOPMENT_DESKTOP_ICONS;
}

export function resolveDesktopDevUrl({ host, port, path = '' }) {
  const origin = `http://${host}:${port}`;
  const previewPath = String(path).trim();
  if (!previewPath) return origin;
  if (!previewPath.startsWith('/') || previewPath.startsWith('//') || /[\r\n]/.test(previewPath)) {
    throw new Error('KORDI_DEV_PREVIEW_PATH must be a local absolute URL path.');
  }
  return new URL(previewPath, `${origin}/`).toString();
}

/**
 * Returns the packaged capabilities (one object or every file in
 * `src-tauri/capabilities`) with the HTTP scope narrowed to the preview's API
 * origin.
 */
export function desktopDevCapabilities(packagedCapabilities, cloudApiBase) {
  const capabilities = structuredClone(
    Array.isArray(packagedCapabilities) ? packagedCapabilities : [packagedCapabilities],
  );
  const apiUrl = new URL(cloudApiBase);
  if (!['http:', 'https:'].includes(apiUrl.protocol)) {
    throw new Error('Desktop Cloud API must use HTTP(S).');
  }
  const httpPermissions = capabilities.flatMap(capability => capability.permissions.filter(
    permission => typeof permission === 'object' && permission.identifier === 'http:default',
  ));
  if (httpPermissions.length === 0) throw new Error('Desktop capability is missing the HTTP permission.');
  for (const httpPermission of httpPermissions) httpPermission.allow = [{ url: apiUrl.origin }];
  return capabilities;
}

function cspSources(value) {
  if (Array.isArray(value)) return [...value];
  return typeof value === 'string' && value.trim() ? value.trim().split(/\s+/) : [];
}

const PRODUCT_CSP_SOURCES = new Set(['https://kordi.ai', 'wss://kordi.ai']);

/**
 * Rewrites the packaged Content-Security-Policy for a named preview: the
 * product API origin is replaced by the preview's API origin, so an isolated
 * profile never allows the product backend unless it is the approved operator
 * profile. `tauri dev` loads the Vite server directly and does not apply the
 * policy, so this matters for CSP-enforcing `tauri build` checks of a profile.
 */
export function desktopDevCsp(baseCsp, cloudApiBase) {
  if (!baseCsp || typeof baseCsp !== 'object' || Array.isArray(baseCsp)) {
    throw new Error('Desktop CSP must be a directive map.');
  }
  const apiUrl = new URL(cloudApiBase);
  if (!['http:', 'https:'].includes(apiUrl.protocol)) {
    throw new Error('Desktop Cloud API must use HTTP(S).');
  }
  const socketOrigin = `${apiUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${apiUrl.host}`;
  const csp = structuredClone(baseCsp);
  const rewrite = (directive, values) => {
    const kept = cspSources(csp[directive]).filter((source) => !PRODUCT_CSP_SOURCES.has(source));
    csp[directive] = [...new Set([...kept, ...values])];
  };
  rewrite('connect-src', [apiUrl.origin, socketOrigin, 'ws://127.0.0.1:*']);
  rewrite('img-src', [apiUrl.origin]);
  rewrite('media-src', [apiUrl.origin]);
  return csp;
}

export function buildBeforeDevCommand({ title, host, port, frontendMode = 'development', env = process.env }) {
  if (!['development', 'production'].includes(frontendMode)) throw new Error('Frontend mode must be development or production.');
  const cloudApiBase = resolveCloudDevApiBase(env);
  const devProfile = resolveCloudDevProfile(env);
  const assignments = [
    `VITE_KORDI_WINDOW_TITLE=${shellQuote(title)}`,
    `VITE_KORDI_CLOUD_API_BASE=${shellQuote(cloudApiBase)}`,
    `VITE_KORDI_DEV_PROFILE=${shellQuote(devProfile)}`,
  ];
  if (env?.VITE_KORDI_PRODUCTION_DEBUG_ACK?.trim()) {
    assignments.push(
      `VITE_KORDI_PRODUCTION_DEBUG_ACK=${shellQuote(env.VITE_KORDI_PRODUCTION_DEBUG_ACK.trim())}`,
    );
  }

  if (frontendMode === 'production') {
    const prefix = `${assignments.join(' ')} NODE_ENV=production`;
    return `${prefix} npm run build && ${prefix} npm run preview -- --host ${shellQuote(host)} --port ${Number(port)} --strictPort`;
  }
  return `${assignments.join(' ')} npm run dev:web -- --host ${host} --port ${port} --strictPort`;
}

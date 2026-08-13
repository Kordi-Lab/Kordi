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

export function buildBeforeDevCommand({ title, host, port, env = process.env }) {
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

  return `${assignments.join(' ')} npm run dev:web -- --host ${host} --port ${port} --strictPort`;
}

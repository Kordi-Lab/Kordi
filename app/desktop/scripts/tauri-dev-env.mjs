import { resolveCloudDevApiBase, resolveCloudDevProfile } from './cloud-dev-endpoint.mjs';

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

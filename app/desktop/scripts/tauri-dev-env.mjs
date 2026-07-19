import { resolveCloudDevApiBase } from './cloud-dev-endpoint.mjs';

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildBeforeDevCommand({ title, host, port, env = process.env }) {
  const cloudApiBase = resolveCloudDevApiBase(env);
  const assignments = [
    `VITE_KORDI_WINDOW_TITLE=${shellQuote(title)}`,
    `VITE_KORDI_CLOUD_API_BASE=${shellQuote(cloudApiBase)}`,
  ];

  return `${assignments.join(' ')} npm run dev:web -- --host ${host} --port ${port} --strictPort`;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function trimmedEnvValue(env, key) {
  const value = env?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function buildBeforeDevCommand({ title, host, port, env = process.env }) {
  const assignments = [
    `VITE_KORDI_WINDOW_TITLE=${shellQuote(title)}`,
  ];

  const cloudApiBase = trimmedEnvValue(env, 'VITE_KORDI_CLOUD_API_BASE');
  if (cloudApiBase) {
    assignments.push(`VITE_KORDI_CLOUD_API_BASE=${shellQuote(cloudApiBase)}`);
  }

  return `${assignments.join(' ')} npm run dev:web -- --host ${host} --port ${port} --strictPort`;
}

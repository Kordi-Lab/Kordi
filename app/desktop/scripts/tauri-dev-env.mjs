export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function trimmedEnvValue(env, key) {
  const value = env?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function buildBeforeDevCommand({ title, host, port, env = process.env }) {
  const viteEdition = trimmedEnvValue(env, 'VITE_KORDI_EDITION');
  const runtimeEdition = trimmedEnvValue(env, 'KORDI_EDITION');
  const frontendEdition = viteEdition || runtimeEdition;
  const assignments = [
    `VITE_KORDI_WINDOW_TITLE=${shellQuote(title)}`,
  ];

  if (frontendEdition) {
    assignments.push(`VITE_KORDI_EDITION=${shellQuote(frontendEdition)}`);
  }
  if (runtimeEdition) {
    assignments.push(`KORDI_EDITION=${shellQuote(runtimeEdition)}`);
  }

  const cloudApiBase = trimmedEnvValue(env, 'VITE_KORDI_CLOUD_API_BASE');
  if (cloudApiBase) {
    assignments.push(`VITE_KORDI_CLOUD_API_BASE=${shellQuote(cloudApiBase)}`);
  }

  const updatePreview = trimmedEnvValue(env, 'VITE_KORDI_PREVIEW_UPDATE');
  if (updatePreview) {
    assignments.push(`VITE_KORDI_PREVIEW_UPDATE=${shellQuote(updatePreview)}`);
  }

  return `${assignments.join(' ')} npm run dev:web -- --host ${host} --port ${port} --strictPort`;
}

/** The error's kind and the start of its message, never the content it was working on. */
export function errorSummary(error: unknown) {
  if (!(error instanceof Error)) return 'Unknown error';
  // Schema errors name the offending nodes with their text after a colon (`Invalid content for node listItem: <…>`).
  const message = error.message.split(':')[0].trim().slice(0, 120);
  return message ? `${error.name}: ${message}` : error.name;
}

/**
 * Reports an error an error boundary caught, as `[area] Kind: message` with
 * no document or message content, through the platform's error reporting
 * (the console and the dev log).
 */
export function reportRenderError(area: string, error: unknown) {
  const report = new Error(`[${area}] ${errorSummary(error)}`);
  report.name = 'RenderError';
  globalThis.reportError?.(report);
}

/** Roots leave caught errors to the boundaries' content-free reports (React would log the whole error). */
export const ROOT_ERROR_OPTIONS = { onCaughtError: () => undefined };

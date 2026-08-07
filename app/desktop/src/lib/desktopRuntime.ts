export function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false;
  return typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

function extractDesktopErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const candidates = [record.message, record.error, record.cause]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
    if (candidates.length > 0) return candidates[0];
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return 'Desktop command failed';
}

export async function invokeDesktop<T>(command: string, args?: Record<string, unknown>) {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(extractDesktopErrorMessage(error));
  }
}

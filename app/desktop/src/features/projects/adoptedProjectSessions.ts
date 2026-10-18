const ADOPTED_KEY = 'kordi.projects.adoptedSessions';

function readAdopted(): Set<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(ADOPTED_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Sessions this Mac runs for a project Mac that is offline. Only that Mac
 * lists them in its catalog, so the server keeps routing them there.
 */
export function adoptedProjectSessionIds(): ReadonlySet<string> {
  return readAdopted();
}

export function rememberAdoptedProjectSession(sessionId: string) {
  const adopted = readAdopted();
  adopted.add(sessionId);
  try { window.localStorage.setItem(ADOPTED_KEY, JSON.stringify([...adopted].slice(-500))); } catch { /* Best effort. */ }
}

import { invokeDesktop, isNativeDesktopShell } from './desktop';

/** The route the latest request sent from this desktop recorded for a session, read from the local mirror. */
export type CanonicalSessionRequestRoute = {
  sessionId: string;
  route: unknown;
  sequenceNum: number;
  updatedAtMs: number;
};

export async function fetchCanonicalSessionRequestRoutes(): Promise<CanonicalSessionRequestRoute[]> {
  if (!isNativeDesktopShell()) return [];
  return invokeDesktop<CanonicalSessionRequestRoute[]>('desktop_canonical_session_request_routes');
}

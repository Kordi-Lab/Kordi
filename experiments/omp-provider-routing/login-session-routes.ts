/**
 * HTTP handlers for hosted login sessions. The caller has already checked the
 * worker bearer token.
 *
 *   POST /login/start               {provider, sessionId, method?}  -> 202 snapshot
 *        method: "default" (the provider's OMP login) or "api-key"; other values -> 400
 *   GET  /login/{id}?wait=&after=                          -> 200 snapshot (long-poll, max 30 s)
 *   POST /login/{id}/input          {value}                -> 202 snapshot
 *   POST /login/{id}/cancel                                -> 200 snapshot
 *   POST /login/{id}/claim                                 -> 200 {provider, material}, once
 *
 * Every error response is `{error: <fixed code>}`.
 */
import type { LoginSessionManager } from './login-session-store';
import { LoginRouteError } from './login-session-types';

const MAX_BODY_LENGTH = 65_536;

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_LENGTH) throw new LoginRouteError(413, 'request_too_large');
  const text = await request.text();
  if (text.length > MAX_BODY_LENGTH) throw new LoginRouteError(413, 'request_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LoginRouteError(400, 'invalid_request');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LoginRouteError(400, 'invalid_request');
  return parsed as Record<string, unknown>;
}

/** Routes one `/login/*` request to the session manager. */
export async function handleLoginRoute(request: Request, manager: LoginSessionManager): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] !== 'login') throw new LoginRouteError(404, 'not_found');
    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'start') {
      const body = await readJsonBody(request);
      return jsonResponse(await manager.start({ provider: body.provider, sessionId: body.sessionId, method: body.method }), 202);
    }
    if (request.method === 'GET' && parts.length === 2) {
      const wait = Number(url.searchParams.get('wait') ?? '0');
      const afterParam = url.searchParams.get('after');
      const after = afterParam === null ? undefined : Number(afterParam);
      return jsonResponse(await manager.poll(parts[1]!, wait, Number.isInteger(after) ? after : undefined, request.signal));
    }
    if (request.method === 'POST' && parts.length === 3) {
      const [, sessionId, action] = parts as [string, string, string];
      if (action === 'input') {
        const body = await readJsonBody(request);
        return jsonResponse(manager.input(sessionId, body.value), 202);
      }
      if (action === 'cancel') return jsonResponse(manager.cancel(sessionId));
      if (action === 'claim') return jsonResponse(manager.claim(sessionId));
    }
    throw new LoginRouteError(404, 'not_found');
  } catch (error) {
    if (error instanceof LoginRouteError) return jsonResponse({ error: error.code }, error.status);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

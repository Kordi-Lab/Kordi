// Fetch through the Tauri HTTP plugin's native client without leaking its
// per-request resources in the Rust host.
//
// The plugin keeps every request and response in the webview's resource table
// until a command closes it. Version 2.6 never closes the request after
// `fetch_send` settles, and it only closes a response once its body is read to
// the end or cancelled. Responses without a body (204, 304) and responses whose
// body a caller never reads therefore stay alive, each holding its own client
// connection. This adapter releases the request as soon as the send settles and
// always drains or cancels the response body before returning a buffered
// Response, so a long-lived desktop session does not grow with every request.
import { invoke } from '@tauri-apps/api/core';

const ERROR_REQUEST_CANCELLED = 'Request cancelled';
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

type NativeFetchResponse = {
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  rid: number;
};

function cancelled(): Error {
  return new Error(ERROR_REQUEST_CANCELLED);
}

function ignoreFailure(promise: Promise<unknown>): Promise<void> {
  return promise.then(() => undefined, () => undefined);
}

// Taking the abort sender first lets the plugin find it through the request;
// closing the request afterwards drops the stored future and its client.
export function releaseNativeRequest(rid: number): Promise<void> {
  return ignoreFailure(invoke('plugin:http|fetch_cancel', { rid }))
    .then(() => ignoreFailure(invoke('plugin:http|fetch_cancel_body', { rid })));
}

function releaseNativeResponse(rid: number): Promise<void> {
  return ignoreFailure(invoke('plugin:http|fetch_cancel_body', { rid }));
}

function requestHeaders(request: Request, init?: RequestInit): [string, string][] {
  const headers = new Headers(init?.headers);
  for (const [key, value] of request.headers) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return Array.from(headers.entries());
}

function chunkBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data as number[]);
}

async function readNativeBody(rid: number, signal?: AbortSignal | null): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    if (signal?.aborted) {
      await releaseNativeResponse(rid);
      throw cancelled();
    }
    let chunk: Uint8Array;
    try {
      chunk = chunkBytes(await invoke('plugin:http|fetch_read_body', { rid }));
    } catch (caught) {
      await releaseNativeResponse(rid);
      throw caught;
    }
    // The plugin appends 1 for the end of the body (and closes the response)
    // or 0 for a data chunk.
    if (chunk[chunk.byteLength - 1] === 1) break;
    const data = chunk.subarray(0, chunk.byteLength - 1);
    chunks.push(data);
    size += data.byteLength;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function nativeCloudFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  if (signal?.aborted) throw cancelled();
  const request = new Request(input, init);
  const buffer = await request.arrayBuffer();
  const data = buffer.byteLength !== 0 ? Array.from(new Uint8Array(buffer)) : null;
  const headers = requestHeaders(request, init);
  if (signal?.aborted) throw cancelled();

  const rid = await invoke<number>('plugin:http|fetch', {
    clientConfig: { method: request.method, url: request.url, headers, data },
  });
  const abort = () => { void invoke('plugin:http|fetch_cancel', { rid }).catch(() => undefined); };
  if (signal?.aborted) {
    abort();
    void releaseNativeRequest(rid);
    throw cancelled();
  }
  signal?.addEventListener('abort', abort);
  let response: NativeFetchResponse;
  try {
    response = await invoke<NativeFetchResponse>('plugin:http|fetch_send', { rid });
  } finally {
    signal?.removeEventListener('abort', abort);
    void releaseNativeRequest(rid);
  }

  let body: Uint8Array | null = null;
  if (NULL_BODY_STATUSES.has(response.status)) {
    void releaseNativeResponse(response.rid);
  } else {
    body = await readNativeBody(response.rid, signal);
  }
  const result = new Response(body as BodyInit | null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(result, 'url', { value: response.url, writable: false });
  return result;
}

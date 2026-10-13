type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type ClientConfig = { url: string; method: string; headers: [string, string][]; data: number[] | null };

export type NativeHttpInvoke = Invoke & { openResources: () => number };

// Exercise native HTTP adapters against synthetic responses. Like the Rust
// plugin, a request stays in the resource table after it is sent until a
// command closes it, and a response stays until its body ends or is cancelled.
export function mockNativeHttpInvoke(fetchImpl: typeof fetch, fallback?: Invoke): NativeHttpInvoke {
  let nextId = 0;
  const requests = new Map<number, ClientConfig>();
  const abortSenders = new Set<number>();
  const responses = new Map<number, Response>();
  const finished = new Set<number>();
  const invoke = async (command: string, args: Record<string, unknown>) => {
    const rid = args?.rid as number;
    switch (command) {
      case 'plugin:http|fetch': {
        const id = ++nextId;
        requests.set(id, args.clientConfig as ClientConfig);
        abortSenders.add(id);
        return id;
      }
      case 'plugin:http|fetch_send': {
        const request = requests.get(rid);
        if (!request) throw new Error('Unknown fixture HTTP request.');
        const response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.data ? new Uint8Array(request.data) : undefined,
        });
        const id = ++nextId;
        responses.set(id, response);
        return { rid: id, status: response.status, statusText: response.statusText,
          headers: Array.from(response.headers.entries()), url: request.url };
      }
      case 'plugin:http|fetch_read_body': {
        if (finished.delete(rid)) {
          responses.delete(rid);
          return new Uint8Array([1]);
        }
        const response = responses.get(rid);
        if (!response) throw new Error('Unknown fixture HTTP response.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const chunk = new Uint8Array(bytes.length + 1);
        chunk.set(bytes);
        finished.add(rid); // A separate read returns the end-of-body marker.
        return chunk;
      }
      case 'plugin:http|fetch_cancel':
        if (!requests.has(rid) || !abortSenders.delete(rid)) throw new Error('Unknown fixture HTTP request.');
        return;
      case 'plugin:http|fetch_cancel_body':
        if (!requests.delete(rid) && !responses.delete(rid)) throw new Error('Unknown fixture HTTP resource.');
        finished.delete(rid);
        return;
      default:
        if (fallback) return fallback(command, args);
        throw new Error(`Unexpected native command: ${command}`);
    }
  };
  return Object.assign(invoke, {
    openResources: () => requests.size + abortSenders.size + responses.size,
  });
}

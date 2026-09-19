type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type ClientConfig = { url: string; method: string; headers: [string, string][]; data: number[] | null };

// Exercise the real HTTP plugin's JavaScript adapter against synthetic responses.
export function mockNativeHttpInvoke(fetchImpl: typeof fetch, fallback?: Invoke): Invoke {
  let nextId = 0;
  const requests = new Map<number, ClientConfig>();
  const responses = new Map<number, Response>();
  const finished = new Set<number>();
  return async (command, args) => {
    const rid = args?.rid as number;
    switch (command) {
      case 'plugin:http|fetch': {
        const id = ++nextId;
        requests.set(id, args.clientConfig as ClientConfig);
        return id;
      }
      case 'plugin:http|fetch_send': {
        const request = requests.get(rid);
        if (!request) throw new Error('Unknown fixture HTTP request.');
        requests.delete(rid);
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
        if (finished.delete(rid)) return new Uint8Array([1]);
        const response = responses.get(rid);
        if (!response) throw new Error('Unknown fixture HTTP response.');
        responses.delete(rid);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const chunk = new Uint8Array(bytes.length + 1);
        chunk.set(bytes);
        finished.add(rid); // A separate read returns the end-of-body marker.
        return chunk;
      }
      case 'plugin:http|fetch_cancel':
        requests.delete(rid);
        return;
      case 'plugin:http|fetch_cancel_body':
        responses.delete(rid);
        finished.delete(rid);
        return;
      default:
        if (fallback) return fallback(command, args);
        throw new Error(`Unexpected native command: ${command}`);
    }
  };
}

export const CHAT_PERFORMANCE_EVENT = 'kordi:performance-span';
export const CHAT_PERFORMANCE_STORAGE_KEY = 'kordi:performance-diagnostics';

export type ChatPerformanceSpanName =
  | 'cloud-message-index'
  | 'canonical-catalog-ipc'
  | 'canonical-page-ipc'
  | 'session-click-to-first-message'
  | 'transcript-virtual-render'
  | 'sidebar-virtual-render'
  | 'cloud-send-to-first-ack';

export type ChatPerformanceMetrics = {
  itemCount?: number;
  messageCount?: number;
  sessionCount?: number;
  rowCount?: number;
  visibleRowCount?: number;
  recipientCount?: number;
  attachmentCount?: number;
  payloadBytes?: number;
  errorCount?: number;
};

export type ChatPerformanceRecord = {
  name: ChatPerformanceSpanName;
  durationMs: number;
  metrics: ChatPerformanceMetrics;
};

export type ChatPerformanceSpan = {
  readonly name: ChatPerformanceSpanName;
  readonly startedAt: number;
  finished: boolean;
};

declare global {
  // Native QA can opt a production build into the same privacy-safe spans.
  // eslint-disable-next-line no-var
  var __KORDI_PERF_DIAGNOSTICS__: boolean | undefined;
}

const MAX_BUFFERED_RECORDS = 500;
const records: ChatPerformanceRecord[] = [];
let pendingSessionClick: { sessionKey: string; span: ChatPerformanceSpan } | null = null;
let cachedStorageOptIn: boolean | null = null;

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function chatPerformanceDiagnosticsEnabled() {
  if (globalThis.__KORDI_PERF_DIAGNOSTICS__ === true) return true;
  if (import.meta.env?.DEV || import.meta.env?.VITE_KORDI_PERF_DIAGNOSTICS === '1') return true;
  if (cachedStorageOptIn !== null) return cachedStorageOptIn;
  try {
    cachedStorageOptIn = typeof window !== 'undefined'
      && window.localStorage?.getItem(CHAT_PERFORMANCE_STORAGE_KEY) === '1';
    return cachedStorageOptIn;
  } catch {
    cachedStorageOptIn = false;
    return false;
  }
}

function safeMetric(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function safeMetrics(metrics: ChatPerformanceMetrics): ChatPerformanceMetrics {
  const result: ChatPerformanceMetrics = {};
  const assign = (key: keyof ChatPerformanceMetrics) => {
    const value = safeMetric(metrics[key]);
    if (value !== undefined) result[key] = value;
  };
  assign('itemCount');
  assign('messageCount');
  assign('sessionCount');
  assign('rowCount');
  assign('visibleRowCount');
  assign('recipientCount');
  assign('attachmentCount');
  assign('payloadBytes');
  assign('errorCount');
  return result;
}

function emit(record: ChatPerformanceRecord, startedAt: number, endedAt: number) {
  records.push(record);
  if (records.length > MAX_BUFFERED_RECORDS) records.splice(0, records.length - MAX_BUFFERED_RECORDS);
  try {
    performance.measure(`kordi:${record.name}`, {
      start: Math.max(0, startedAt),
      end: Math.max(startedAt, endedAt),
      detail: record.metrics,
    });
  } catch {
    // The JSON record remains available on older WebKit performance APIs.
  }
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ChatPerformanceRecord>(CHAT_PERFORMANCE_EVENT, { detail: record }));
  }
  // Counts, bytes, and durations only; never include source payloads or correlation ids.
  // eslint-disable-next-line no-console
  console.debug('[kordi-performance]', record);
}

export function beginChatPerformanceSpan(name: ChatPerformanceSpanName): ChatPerformanceSpan | null {
  if (!chatPerformanceDiagnosticsEnabled()) return null;
  return { name, startedAt: now(), finished: false };
}

export function finishChatPerformanceSpan(
  span: ChatPerformanceSpan | null,
  metricsOrFactory: ChatPerformanceMetrics | (() => ChatPerformanceMetrics) = {},
) {
  if (!span || span.finished) return null;
  const endedAt = now();
  span.finished = true;
  const metrics = typeof metricsOrFactory === 'function' ? metricsOrFactory() : metricsOrFactory;
  const record: ChatPerformanceRecord = {
    name: span.name,
    durationMs: Number(Math.max(0, endedAt - span.startedAt).toFixed(3)),
    metrics: safeMetrics(metrics),
  };
  emit(record, span.startedAt, endedAt);
  return record;
}

export function chatPerformancePayloadBytes(value: unknown) {
  if (!chatPerformanceDiagnosticsEnabled()) return undefined;
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    let bytes = 0;
    for (let index = 0; index < serialized.length; index += 1) {
      const codeUnit = serialized.charCodeAt(index);
      if (codeUnit <= 0x7f) bytes += 1;
      else if (codeUnit <= 0x7ff) bytes += 2;
      else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = serialized.charCodeAt(index + 1);
        if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  } catch {
    return undefined;
  }
}

export function startSessionClickToFirstMessage(sessionKey: string) {
  const normalizedSessionKey = sessionKey.trim();
  const span = normalizedSessionKey
    ? beginChatPerformanceSpan('session-click-to-first-message')
    : null;
  pendingSessionClick = span ? { sessionKey: normalizedSessionKey, span } : null;
}

export function completeSessionClickToFirstMessage(
  sessionKey: string,
  metrics: Pick<ChatPerformanceMetrics, 'messageCount' | 'visibleRowCount'>,
) {
  const pending = pendingSessionClick;
  if (!pending || pending.sessionKey !== sessionKey.trim()) return null;
  pendingSessionClick = null;
  return finishChatPerformanceSpan(pending.span, metrics);
}

export function readChatPerformanceRecords(): readonly ChatPerformanceRecord[] {
  return records.map((record) => ({ ...record, metrics: { ...record.metrics } }));
}

export function clearChatPerformanceRecords() {
  records.length = 0;
  pendingSessionClick = null;
}

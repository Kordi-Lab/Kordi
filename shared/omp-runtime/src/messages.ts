import type { JsonObject } from './protocol';

const fields: Record<string, string> = {
  tool_call_id: 'toolCallId', tool_name: 'toolName', is_error: 'isError',
  stop_reason: 'stopReason', error_message: 'errorMessage', cache_read: 'cacheRead',
  cache_write: 'cacheWrite', total_tokens: 'totalTokens', custom_type: 'customType',
  from_id: 'fromId', tokens_before: 'tokensBefore', exit_code: 'exitCode', full_output_path: 'fullOutputPath',
  mime_type: 'mimeType',
};
function mapKeys(value: any, mapping: Record<string, string>): any {
  if (Array.isArray(value)) return value.map(item => mapKeys(item, mapping));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [mapping[key] ?? key,
    // Tool arguments/details are application data, never rename their keys.
    ['arguments', 'details', 'metadata'].includes(key) ? item : mapKeys(item, mapping)]));
}
export function toOmpMessage(message: JsonObject, api: string, model?: { provider: string; id: string }): any {
  const result = mapKeys(message, fields);
  if (typeof result.content === 'string') result.content = [{ type: 'text', text: result.content }];
  if (result.role) result.timestamp ??= 0;
  if (result.role === 'assistant') {
    result.api ??= api;
    result.provider ??= model?.provider;
    result.model ??= model?.id;
    result.stopReason ??= 'stop';
    result.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  }
  return result;
}
export function toKordiMessage(message: JsonObject): JsonObject {
  return mapKeys(message, Object.fromEntries(Object.entries(fields).map(([a, b]) => [b, a])));
}

import { expect, test } from 'bun:test';
import { providerErrorCode, providerReasonText } from '../src/runtime';

test('provider errors expose only fixed classifications and HTTP status', () => {
  expect(providerErrorCode({ errorStatus: 401, errorMessage: 'secret bearer credential' })).toBe('provider_http_401');
  expect(providerErrorCode({ errorMessage: 'Model private-model not supported for this account' })).toBe('provider_model_unavailable');
  expect(providerErrorCode({ errorMessage: 'Invalid tool schema: private schema content' })).toBe('provider_tool_schema');
  expect(providerErrorCode({ errorMessage: 'private request body and account session' })).toBe('provider_error');
  expect(providerErrorCode({ errorStatus: 200 })).toBe('provider_error');
});

test('rate limits reported without an HTTP status are still classified', () => {
  expect(providerErrorCode({ errorMessage: 'Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded)' })).toBe('provider_http_429');
  expect(providerErrorCode({ errorMessage: 'Rate limit reached for requests' })).toBe('provider_http_429');
  expect(providerErrorCode({ errorMessage: 'Overloaded' })).toBe('provider_http_503');
  expect(providerErrorCode({ errorStatus: 500, errorMessage: 'rate limit' })).toBe('provider_http_500');
});

test('the provider reason keeps one line for the host to clean', () => {
  expect(providerReasonText('Codex is at capacity\nstack trace')).toBe('Codex is at capacity');
  expect(providerReasonText('   ')).toBeUndefined();
  expect(providerReasonText(undefined)).toBeUndefined();
  expect(providerReasonText('x'.repeat(5000))?.length).toBe(2000);
});

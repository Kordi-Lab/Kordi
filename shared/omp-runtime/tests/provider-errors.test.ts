import { expect, test } from 'bun:test';
import { providerErrorCode } from '../src/runtime';

test('provider errors expose only fixed classifications and HTTP status', () => {
  expect(providerErrorCode({ errorStatus: 401, errorMessage: 'secret bearer credential' })).toBe('provider_http_401');
  expect(providerErrorCode({ errorMessage: 'Model private-model not supported for this account' })).toBe('provider_model_unavailable');
  expect(providerErrorCode({ errorMessage: 'Invalid tool schema: private schema content' })).toBe('provider_tool_schema');
  expect(providerErrorCode({ errorMessage: 'private request body and account session' })).toBe('provider_error');
  expect(providerErrorCode({ errorStatus: 200 })).toBe('provider_error');
});

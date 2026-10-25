import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withoutProviderResponse } from '../src/features/cloud/providerFailureText';

test('replies other people read keep only the fixed failure wording', () => {
  const owner = 'The provider is busy or rate-limited. Try again shortly. Provider response: You have hit your usage limit (plus plan).';
  assert.equal(withoutProviderResponse(owner), 'The provider is busy or rate-limited. Try again shortly.');
  assert.equal(withoutProviderResponse('Request failed.'), 'Request failed.');
  assert.equal(withoutProviderResponse(null), null);
  assert.equal(withoutProviderResponse(undefined), undefined);
});

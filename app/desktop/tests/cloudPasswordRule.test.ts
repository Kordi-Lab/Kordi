import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { cloudLoginErrorMessage, passwordMeetsSignupRule } from '../src/kordi-app/cloud/cloudLoginMessages';

test('sign-up password rule needs eight characters, mixed case, and a number', () => {
  assert.equal(passwordMeetsSignupRule('Correct-horse-7'), true);
  assert.equal(passwordMeetsSignupRule('Short7a'), false);
  assert.equal(passwordMeetsSignupRule('all-lowercase-1'), false);
  assert.equal(passwordMeetsSignupRule('ALL-UPPERCASE-1'), false);
  assert.equal(passwordMeetsSignupRule('No-Numbers-Here'), false);
});

test('weak password errors show the server message and fall back to the full rule', () => {
  const serverMessage = 'Password must include an uppercase letter, a lowercase letter, and a number.';
  assert.equal(cloudLoginErrorMessage(new CloudAuthError('weak_password', serverMessage, 400), false), serverMessage);
  assert.equal(
    cloudLoginErrorMessage(new CloudAuthError('weak_password', '', 400), false),
    'Password must have at least 8 characters, with an uppercase letter, a lowercase letter, and a number.',
  );
});

test('rate-limit errors name the wait the server asked for', () => {
  assert.equal(
    cloudLoginErrorMessage(new CloudAuthError('rate_limited', '', 429, 42), false),
    'Too many attempts. Try again in 42 seconds.',
  );
  assert.equal(
    cloudLoginErrorMessage(new CloudAuthError('rate_limited', '', 429, 600), false),
    'Too many attempts. Try again in 10 minutes.',
  );
  assert.equal(
    cloudLoginErrorMessage(new CloudAuthError('rate_limited', '', 429), false),
    'Too many attempts. Wait a moment, then try again.',
  );
});

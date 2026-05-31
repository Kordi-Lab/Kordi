import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SIGNUP_AVATAR_PALETTES,
  cloudSignupAvatarBackground,
} from '../src/features/cloud/signupAvatar';

test('generated human avatars use the muted Kordi sidebar palette', () => {
  assert.deepEqual(SIGNUP_AVATAR_PALETTES, [
    { from: '#6FCF97', to: '#6FCF97', foreground: '#1F2937' },
    { from: '#F2A65A', to: '#F2A65A', foreground: '#1F2937' },
    { from: '#E8A0C8', to: '#E8A0C8', foreground: '#1F2937' },
  ]);

  assert.equal(
    cloudSignupAvatarBackground(SIGNUP_AVATAR_PALETTES[0]),
    'linear-gradient(135deg, #6FCF97 0%, #6FCF97 100%)',
  );
});

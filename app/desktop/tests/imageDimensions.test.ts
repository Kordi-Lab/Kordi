import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fittedImageDisplaySize,
  normalizedImagePixelDimensions,
} from '../src/lib/imageDimensions';

test('image dimensions validate and fit without upscaling', () => {
  assert.deepEqual(normalizedImagePixelDimensions(1_600, 900), {
    widthPixels: 1_600,
    heightPixels: 900,
  });
  assert.equal(normalizedImagePixelDimensions(0, 900), null);
  assert.equal(normalizedImagePixelDimensions(1_600.5, 900), null);
  assert.equal(normalizedImagePixelDimensions(100_001, 900), null);
  assert.deepEqual(
    fittedImageDisplaySize({ widthPixels: 1_600, heightPixels: 900 }, 464, 320),
    { width: 464, height: 261 },
  );
  assert.deepEqual(
    fittedImageDisplaySize({ widthPixels: 120, heightPixels: 80 }, 464, 320),
    { width: 120, height: 80 },
  );
});

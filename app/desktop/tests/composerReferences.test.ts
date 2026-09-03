import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composerFileReferenceOptions,
  composerReferenceDirectorySearch,
} from '../src/pages/useComposerReferenceOptions';

test('composer reference search separates the directory from the typed filename', () => {
  assert.equal(composerReferenceDirectorySearch(''), null);
  assert.equal(composerReferenceDirectorySearch('~'), null);
  assert.equal(composerReferenceDirectorySearch('README.md'), null);
  assert.deepEqual(composerReferenceDirectorySearch('./src/App.tsx'), {
    directory: './src',
    prefix: './src/',
    leaf: 'App.tsx',
  });
  assert.deepEqual(composerReferenceDirectorySearch('src/components/App.tsx'), {
    directory: 'src/components',
    prefix: 'src/components/',
    leaf: 'App.tsx',
  });
  assert.deepEqual(composerReferenceDirectorySearch('/workspace/My Project/file.md'), {
    directory: '/workspace/My Project',
    prefix: '/workspace/My Project/',
    leaf: 'file.md',
  });
  assert.deepEqual(composerReferenceDirectorySearch('C:\\project\\file.txt'), {
    directory: 'C:\\project',
    prefix: 'C:\\project\\',
    leaf: 'file.txt',
  });
  assert.equal(composerReferenceDirectorySearch('https://example.com/reference'), null);
});

test('folder completion keeps directories navigable and attaches only the selected file path', () => {
  const search = composerReferenceDirectorySearch('src/com');
  assert.ok(search);
  const options = composerFileReferenceOptions([
    {
      name: 'components',
      path: '/workspace/src/components',
      kind: 'directory',
      isDirectory: true,
    },
    {
      name: 'composer.tsx',
      path: '/workspace/src/composer.tsx',
      kind: 'code',
      isDirectory: false,
    },
    {
      name: 'unrelated.ts',
      path: '/workspace/src/unrelated.ts',
      kind: 'code',
      isDirectory: false,
    },
  ], search);

  assert.deepEqual(options.map((option) => ({
    value: option.value,
    kind: option.referenceKind,
    path: option.referencePath,
    keepOpen: option.keepMenuOpen,
  })), [
    {
      value: 'src/components/',
      kind: 'directory',
      path: '/workspace/src/components',
      keepOpen: true,
    },
    {
      value: 'src/composer.tsx',
      kind: 'file',
      path: '/workspace/src/composer.tsx',
      keepOpen: false,
    },
  ]);
});

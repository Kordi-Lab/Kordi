import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ComposerMentionOption } from '../src/kordi-app/components';
import {
  currentMentionQuery,
  filterMentionTargets,
  insertComposerMention,
} from '../src/kordi-app/components/composerMentionOptions';

test('mention query follows the caret and can start directly after message text', () => {
  const text = 'Please review@src/App.tsx before sending';
  const cursor = text.indexOf(' before');

  assert.deepEqual(currentMentionQuery(text, cursor), {
    start: 'Please review'.length,
    end: cursor,
    normalized: 'src/app.tsx',
    raw: 'src/App.tsx',
    trailingWhitespace: false,
  });
  assert.equal(currentMentionQuery('Message@')?.raw, '');
});

test('mention insertion replaces only the active caret token', () => {
  const text = 'Ask @Ali about this';
  const query = currentMentionQuery(text, 'Ask @Ali'.length);
  assert.ok(query);
  const contact = {
    value: 'Alice',
    label: 'Alice',
    targetKind: 'person',
    sourceHostId: 'host',
    nodeId: 'human-alice',
    runtime: 'person',
  } as ComposerMentionOption;

  assert.deepEqual(insertComposerMention(text, query, contact), {
    value: 'Ask @Alice about this',
    cursor: 'Ask @Alice'.length,
  });
});

test('reference suggestions preserve URLs and wait for verified file matches', () => {
  const urlText = 'Use @https://example.com/reference';
  const urlQuery = currentMentionQuery(urlText);
  assert.ok(urlQuery);
  const [url] = filterMentionTargets([], urlQuery);
  assert.ok(url);
  assert.equal(url.referenceKind, 'url');
  assert.equal(insertComposerMention(urlText, urlQuery, url).value, 'Use https://example.com/reference ');

  const pathQuery = currentMentionQuery('Review @"./Design Files/brief.md');
  assert.equal(pathQuery?.raw, './Design Files/brief.md');
  assert.deepEqual(filterMentionTargets([], pathQuery), []);
});

test('space completes a reference and later prose does not reopen the popup', () => {
  for (const path of ['~/project/', '~/project', './src/', 'https://example.com/page']) {
    assert.ok(currentMentionQuery(`@${path}`));
    assert.equal(currentMentionQuery(`@${path} `), null);
    assert.equal(currentMentionQuery(`@${path} Read package.json and run pwd.`), null);
  }
  assert.equal(currentMentionQuery('@"~/My Project/" '), null);
  assert.equal(currentMentionQuery('@~/project/ continue @src/')?.raw, 'src/');
});

test('folder names with spaces are quoted while keeping the caret inside the path', () => {
  const text = 'Open @~/';
  const query = currentMentionQuery(text);
  assert.ok(query);
  const folder = {
    value: '~/My Project/', label: 'My Project/', targetKind: 'reference',
    sourceHostId: 'local-files', nodeId: 'project', runtime: 'reference',
    referenceKind: 'directory', keepMenuOpen: true,
  } as ComposerMentionOption;
  const insertion = insertComposerMention(text, query, folder);
  assert.equal(insertion.value, 'Open @"~/My Project/"');
  assert.equal(insertion.cursor, insertion.value.length - 1);
  const nextQuery = currentMentionQuery(insertion.value, insertion.cursor);
  assert.equal(nextQuery?.raw, '~/My Project/');
  assert.ok(nextQuery);
  assert.equal(insertComposerMention(insertion.value, nextQuery, { ...folder, value: '~/My Project/src/' }).value, 'Open @"~/My Project/src/"');
});

test('empty reference selection opens the native file picker action', () => {
  const text = 'Please review @';
  const query = currentMentionQuery(text);
  assert.ok(query);
  const picker = filterMentionTargets([], query).find((item) => item.referenceAction === 'pick-file');
  assert.ok(picker);
  assert.deepEqual(insertComposerMention(text, query, picker), {
    value: 'Please review ',
    cursor: 'Please review '.length,
  });
});

test('local path action starts autocomplete from the home folder', () => {
  const text = 'Please review @';
  const query = currentMentionQuery(text);
  assert.ok(query);
  const localPath = filterMentionTargets([], query).find((item) => item.label === 'Local path');
  assert.ok(localPath);
  assert.equal(localPath.referenceAction, 'home-path');
  assert.equal(localPath.detail, 'Browse from your home folder');
  assert.deepEqual(insertComposerMention(text, query, localPath), {
    value: 'Please review @~/',
    cursor: 'Please review @~/'.length,
  });
});

test('typed reference paths wait for verified filesystem matches', () => {
  assert.deepEqual(filterMentionTargets([], currentMentionQuery('Open @~')), []);
  assert.deepEqual(filterMentionTargets([], currentMentionQuery('Open @~/')), []);
});

test('folder references keep autocomplete open for the next path segment', () => {
  const text = 'Open @src/comp';
  const query = currentMentionQuery(text);
  assert.ok(query);
  const folder = {
    value: 'src/components/',
    label: 'components/',
    targetKind: 'reference',
    sourceHostId: 'local-files',
    nodeId: '/workspace/src/components',
    runtime: 'reference',
    referenceKind: 'directory',
    keepMenuOpen: true,
  } as ComposerMentionOption;

  assert.deepEqual(insertComposerMention(text, query, folder), {
    value: 'Open @src/components/',
    cursor: 'Open @src/components/'.length,
  });
});

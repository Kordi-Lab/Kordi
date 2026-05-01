import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  desktopSlashCommandIsExcluded,
  filterDesktopSlashCommands,
  isDesktopHandledSlashCommand,
} from '../src/features/chat/composerController.shared';
import type { DesktopChatSlashCommand } from '../src/kordi-app/types';

const commandItems = (
  values: Array<string | { value: string; kind?: DesktopChatSlashCommand['kind'] }>,
): DesktopChatSlashCommand[] => values.map((entry) => {
  const value = typeof entry === 'string' ? entry : entry.value;
  return {
    label: value,
    value,
    detail: `${value} detail`,
    kind: typeof entry === 'string' ? 'builtin' : entry.kind ?? 'builtin',
  } as DesktopChatSlashCommand;
});

test('desktop slash command catalog removes app-native commands but keeps session/runtime commands', () => {
  const filtered = filterDesktopSlashCommands(commandItems([
    '/help',
    '/settings',
    '/model',
    '/new',
    '/resume',
    '/name',
    '/session',
    '/copy',
    '/quit',
    '/exit',
    '/image',
    '/update',
    '/compact',
    '/fork',
    '/tree',
    '/export',
    '/import',
    '/reload',
    '/install',
    '/skill',
    '/skill:review',
    '/summarize',
  ])).map((item) => item.value);

  assert.deepEqual(filtered, [
    '/compact',
    '/fork',
    '/tree',
    '/export',
    '/import',
    '/reload',
    '/install',
    '/skill',
    '/skill:review',
    '/summarize',
  ]);
});

test('desktop slash command classifier treats removed commands as unsupported app commands', () => {
  for (const command of ['/help', '/hotkeys', '/settings', '/login', '/logout', '/model', '/new', '/resume', '/name', '/session', '/copy', '/quit', '/exit', '/image', '/update']) {
    assert.equal(desktopSlashCommandIsExcluded(command), true, `${command} should be excluded from desktop command UX`);
    assert.equal(isDesktopHandledSlashCommand(command, commandItems(['/compact', '/reload'])), false, `${command} should not execute as a desktop command`);
  }
});

test('desktop slash command classifier keeps agent prompt commands out of local handling', () => {
  const catalog = commandItems([
    '/compact',
    '/reload',
    '/install',
    { value: '/skill:review', kind: 'skill' },
    { value: '/summarize', kind: 'prompt' },
    { value: '/extension-menu', kind: 'extension' },
  ]);

  assert.equal(isDesktopHandledSlashCommand('/compact', catalog), true);
  assert.equal(isDesktopHandledSlashCommand('/install', catalog), true);
  assert.equal(isDesktopHandledSlashCommand('/extension-menu', catalog), true);
  assert.equal(isDesktopHandledSlashCommand('/skill:review', catalog), false);
  assert.equal(isDesktopHandledSlashCommand('/skill:review focus on tests', catalog), false);
  assert.equal(isDesktopHandledSlashCommand('/summarize', catalog), false);
  assert.equal(isDesktopHandledSlashCommand('/summarize release notes', catalog), false);
  assert.equal(isDesktopHandledSlashCommand('/unknown', catalog), false);
});

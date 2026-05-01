import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  desktopSlashCommandIsExcluded,
  filterDesktopSlashCommands,
  isDesktopHandledSlashCommand,
} from '../src/features/chat/composerController.shared';
import type { DesktopChatSlashCommand } from '../src/kordi-app/types';

const commandItems = (values: string[]): DesktopChatSlashCommand[] => values.map((value) => ({
  label: value,
  value,
  detail: `${value} detail`,
}));

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

test('desktop slash command classifier handles static runtime commands and dynamic runtime commands', () => {
  const catalog = commandItems(['/compact', '/reload', '/install', '/skill:review', '/summarize']);

  assert.equal(isDesktopHandledSlashCommand('/compact', catalog), true);
  assert.equal(isDesktopHandledSlashCommand('/install', catalog), true);
  assert.equal(isDesktopHandledSlashCommand('/skill:review', catalog), true);
  assert.equal(isDesktopHandledSlashCommand('/summarize', catalog), true);
  assert.equal(isDesktopHandledSlashCommand('/unknown', catalog), false);
});

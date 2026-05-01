import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  acceptedDesktopSlashCommandText,
  desktopSlashCommandEnterAction,
  desktopSlashCommandIsExcluded,
  desktopSlashCommandQuery,
  filterDesktopSlashCommands,
  isDesktopHandledSlashCommand,
  leadingSlashCommandTextParts,
} from '../src/features/chat/composerController.shared';
import { ComposerSlashCommandHighlight, MessageBubble } from '../src/kordi-app/components';
import type { DesktopChatSlashCommand, Message } from '../src/kordi-app/types';

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

test('absolute file paths do not open or render as slash commands', () => {
  const imagePath = '/var/folders/sj/4t94lr1x6nz054myq77r2b4c0000gn/T/pi-clipboard-b9f3a7fc-c9bb-4c97-b785-02ef613131f9.png';
  const catalog = commandItems([
    '/export',
    { value: '/skill:review', kind: 'skill' },
    { value: '/summarize', kind: 'prompt' },
  ]);

  assert.equal(desktopSlashCommandQuery('/'), '/');
  assert.equal(desktopSlashCommandQuery('/skill:review'), '/skill:review');
  assert.equal(desktopSlashCommandQuery(imagePath), null);
  assert.equal(leadingSlashCommandTextParts(imagePath, catalog), null);
  assert.equal(renderToStaticMarkup(React.createElement(ComposerSlashCommandHighlight, {
    text: imagePath,
    slashCommands: catalog,
  })), '');
});

test('leading slash command text parts isolate the command token for inline highlighting', () => {
  const catalog = commandItems([
    { value: '/skill:writing-skills', kind: 'skill' },
    { value: '/summarize', kind: 'prompt' },
    '/reload',
  ]);

  assert.deepEqual(leadingSlashCommandTextParts('/skill:writing-skills use this', catalog), {
    command: '/skill:writing-skills',
    rest: ' use this',
    kind: 'skill',
  });
  assert.deepEqual(leadingSlashCommandTextParts('/summarize notes', catalog), {
    command: '/summarize',
    rest: ' notes',
    kind: 'prompt',
  });
  assert.equal(leadingSlashCommandTextParts(' /summarize notes', catalog), null);
});

test('accepted slash commands place the caret at the command end without adding a trailing space', () => {
  assert.equal(acceptedDesktopSlashCommandText('/skill:using-superpowers'), '/skill:using-superpowers');
  assert.equal(acceptedDesktopSlashCommandText('/export   '), '/export');
});

test('enter accepts agent prompt slash commands so users can continue typing after the command', () => {
  assert.equal(desktopSlashCommandEnterAction(commandItems([{ value: '/skill:using-superpowers', kind: 'skill' }])[0]), 'accept');
  assert.equal(desktopSlashCommandEnterAction(commandItems([{ value: '/summarize', kind: 'prompt' }])[0]), 'accept');
  assert.equal(desktopSlashCommandEnterAction(commandItems(['/export'])[0]), 'run');
});

test('composer slash command highlight and textareas share explicit text measurement styles', () => {
  const html = renderToStaticMarkup(React.createElement(ComposerSlashCommandHighlight, {
    text: '/export',
    slashCommands: commandItems(['/export']),
  }));
  const chatsPage = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  const projectsPage = readFileSync(new URL('../src/pages/ProjectsPage.tsx', import.meta.url), 'utf8');
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');

  assert.match(html, /app-composer-text-measure/);
  assert.match(chatsPage, /app-composer-text-measure/);
  assert.match(projectsPage, /app-composer-text-measure/);
  assert.match(shellCss, /\.app-composer-text-measure\s*{[\s\S]*font-size:\s*15px;/);
  assert.match(shellCss, /\.app-composer-text-measure\s*{[\s\S]*line-height:\s*24px;/);
  assert.match(shellCss, /\.app-composer-text-measure\s*{[\s\S]*font-weight:\s*400;/);
});

test('composer slash command highlight preserves textarea font weight so the caret stays aligned', () => {
  const html = renderToStaticMarkup(React.createElement(ComposerSlashCommandHighlight, {
    text: '/export notes',
    slashCommands: commandItems(['/export']),
  }));

  assert.match(html, /text-sky-300/);
  assert.doesNotMatch(html, /font-semibold/);
});

test('own message slash command highlight uses dark high-contrast colors on the light sender bubble', () => {
  const msg: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: '/skill:using-superpowers',
    time: '16:01',
  };
  const html = renderToStaticMarkup(React.createElement(MessageBubble, {
    msg,
    slashCommands: commandItems([{ value: '/skill:using-superpowers', kind: 'skill' }]),
  }));

  assert.match(html, /text-violet-800/);
  assert.doesNotMatch(html, /text-violet-200/);
});

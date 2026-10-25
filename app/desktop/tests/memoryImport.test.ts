import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentFileSizeLabel,
  agentFilesBySource,
  importedCountLabel,
  memoryImportSaves,
  memoryTextKey,
  parseMemoryImportReply,
  withChosenFiles,
  type AgentInstructionFile,
} from '../src/features/memory/memoryImport';
import { appSummary, memoryImportTree, rollUpLabel } from '../src/features/memory/memoryImportTreeModel';
import { memoryImportRoute } from '../src/features/memory/memoryImportClient';
import { lessonOriginLabel, lessonSourceLabel } from '../src/features/memory/memoryModel';

const projectFile: AgentInstructionFile = {
  path: '/work/launch-site/AGENTS.md',
  root: '/work/launch-site',
  projectName: 'launch-site',
  fileName: 'AGENTS.md',
  source: 'Project file',
  size: 4_300,
  modifiedAt: 1,
};
const homeFile: AgentInstructionFile = {
  path: '/home/sample/.claude/CLAUDE.md',
  root: null,
  projectName: 'Home',
  fileName: '.claude/CLAUDE.md',
  source: 'Claude Code',
  size: 900,
  modifiedAt: 1,
};

test('an import reply is parsed from JSON wrapped in a fence or a sentence', () => {
  const reply = [
    'Here are the memories:',
    '```json',
    JSON.stringify({ memories: [
      { text: '  Use pnpm   for every script. ', category: 'hcp-custom:task_lessons', scope: 'project', file: projectFile.path },
      { text: 'Answer in British English.', category: 'general_preferences', scope: 'global', file: projectFile.path },
      { text: 'Leads the design team.', category: 'work_context', scope: 'project' },
    ] }),
    '```',
  ].join('\n');
  assert.deepEqual(parseMemoryImportReply(reply, [projectFile]), [
    { text: 'Use pnpm for every script.', category: 'hcp-custom:task_lessons', scope: 'project', file: projectFile.path },
    { text: 'Answer in British English.', category: 'general_preferences', scope: 'global', file: projectFile.path },
    { text: 'Leads the design team.', category: 'work_context', scope: 'project', file: projectFile.path },
  ]);
});

test('an import reply drops bad entries, unknown files, and anything past 12 per file', () => {
  const many = Array.from({ length: 15 }, (_, index) => ({ text: `Rule number ${index}.`, file: projectFile.path }));
  const reply = JSON.stringify({ memories: [
    { text: '', file: projectFile.path },
    { text: 'x'.repeat(501), file: projectFile.path },
    { text: 'From a file that was not sent.', file: '/elsewhere/AGENTS.md' },
    { text: 'No file with two files sent.' },
    { text: 'Odd category falls back by scope.', category: 'secret_stuff', scope: 'global', file: homeFile.path },
    'not an object',
    ...many,
  ] });
  const parsed = parseMemoryImportReply(reply, [projectFile, homeFile]);
  assert.equal(parsed.filter((memory) => memory.file === projectFile.path).length, 12);
  assert.deepEqual(parsed.find((memory) => memory.file === homeFile.path), {
    text: 'Odd category falls back by scope.', category: 'general_preferences', scope: 'global', file: homeFile.path,
  });
  assert.equal(parsed.find((memory) => memory.file === projectFile.path)?.category, 'hcp-custom:task_lessons');
  assert.deepEqual(parseMemoryImportReply('No JSON here.', [projectFile]), []);
  assert.deepEqual(parseMemoryImportReply('{"memories": "none"}', [projectFile]), []);
  assert.deepEqual(parseMemoryImportReply('{"memories": [ broken', [projectFile]), []);
});

test('imported memories map to project or account scope, skip repeats, and carry no confidence', () => {
  const saves = memoryImportSaves([
    { text: 'Use pnpm for every script.', category: 'hcp-custom:task_lessons', scope: 'project', file: projectFile.path },
    { text: 'Answer in British English.', category: 'general_preferences', scope: 'global', file: projectFile.path },
    { text: 'answer in british   english. ', category: 'general_preferences', scope: 'global', file: homeFile.path },
    { text: 'RUN THE LINTER BEFORE A COMMIT.', category: 'hcp-custom:task_lessons', scope: 'project', file: projectFile.path },
    { text: 'Keep replies short.', category: 'hcp-custom:task_lessons', scope: 'project', file: homeFile.path },
    { text: 'From an unknown file.', category: 'work_context', scope: 'project', file: '/elsewhere/AGENTS.md' },
  ], [projectFile, homeFile], ['Run the linter before a commit.']);
  assert.deepEqual(saves, [
    { file: projectFile.path, save: { scope: 'project', scopeId: '/work/launch-site', scopeLabel: 'launch-site', source: 'import', text: 'Use pnpm for every script.', category: 'hcp-custom:task_lessons' } },
    { file: projectFile.path, save: { scope: 'global', scopeId: 'account', scopeLabel: 'Global', source: 'import', text: 'Answer in British English.', category: 'general_preferences' } },
    { file: homeFile.path, save: { scope: 'global', scopeId: 'account', scopeLabel: 'Global', source: 'import', text: 'Keep replies short.', category: 'hcp-custom:task_lessons' } },
  ]);
  assert.ok(saves.every(({ save }) => !('confidence' in save)));
  assert.equal(memoryTextKey('  A  b C '), 'a b c');
});

test('import labels', () => {
  assert.equal(agentFileSizeLabel(900), '900 B');
  assert.equal(agentFileSizeLabel(4_300), '4 KB');
  assert.equal(importedCountLabel(0), 'Nothing new');
  assert.equal(importedCountLabel(1), 'Imported 1 memory');
  assert.equal(importedCountLabel(3), 'Imported 3 memories');
  assert.equal(lessonSourceLabel('import'), 'Imported');
  assert.equal(lessonOriginLabel({ source: 'import', declarationType: 'user-declared' }, 'acct'), 'Imported');
});

test('chosen files join the list once, after the discovered ones', () => {
  const chosen: AgentInstructionFile = { ...projectFile, path: '/work/notes/rules.md', root: '/work/notes', projectName: 'notes', fileName: 'rules.md' };
  assert.deepEqual(
    withChosenFiles([projectFile], [chosen, { ...projectFile }, { ...chosen }]).map((file) => file.path),
    ['/work/launch-site/AGENTS.md', '/work/notes/rules.md'],
  );
});

test('an import runs with the chat route at low thinking and falls back to the fast model', () => {
  const route = { model: 'openai-codex/gpt-5.5', authProvider: 'openai-codex', authChoice: 'cloud-login:work', thinking: 'high' };
  assert.deepEqual(memoryImportRoute(route), {
    route: { ...route, thinking: 'low' },
    fallbackModel: 'openai-codex/gpt-5.6-luna',
  });
  assert.deepEqual(memoryImportRoute({ ...route, model: 'openai-codex/gpt-5.6-luna' }).fallbackModel, null);
  assert.deepEqual(memoryImportRoute(null), { route: null, fallbackModel: null });
});

test('the list is grouped by app in the order each app first appears', () => {
  const groups = agentFilesBySource([projectFile, homeFile, { ...projectFile, path: '/work/other/AGENTS.md' }]);
  assert.deepEqual(groups.map((group) => [group.source, group.files.length]), [['Project file', 2], ['Claude Code', 1]]);
});

test('the import tree skips the project level for a one-project app and rolls results up', () => {
  const file = (path: string, source: string, root: string | null, projectName: string): AgentInstructionFile => ({
    path, root, projectName, fileName: path.split('/').pop() ?? path, source, size: 100, modifiedAt: 0,
  });
  const files = [
    file('/a/one.md', 'Claude Code', '/a', 'a'),
    file('/b/two.md', 'Claude Code', '/b', 'b'),
    file('/home/three.md', 'Claude Code', null, 'Home'),
    file('/a/AGENTS.md', 'Project file', '/a', 'a'),
  ];
  const [claude, project] = memoryImportTree(files);
  assert.deepEqual([claude.name, appSummary(claude), claude.projects.map((group) => group.name)], ['Claude Code', '3 projects · 3 files', ['a', 'b', 'Home']]);
  assert.deepEqual([project.name, appSummary(project), project.projects.length], ['Project files', '1 file', 0]);
  assert.equal(rollUpLabel(claude.files, {}, 'app'), '');
  assert.equal(rollUpLabel(claude.files, { '/a/one.md': 2, '/b/two.md': 'importing' }, 'project'), 'Importing 1/2…');
  assert.equal(rollUpLabel(claude.files, { '/a/one.md': 2, '/b/two.md': 'importing' }, 'app'), 'Importing…');
  assert.equal(rollUpLabel(claude.files, { '/a/one.md': 2, '/b/two.md': { failed: 'x' } }, 'app'), 'Imported 2 memories');
  assert.equal(rollUpLabel(claude.files, { '/a/one.md': { failed: 'x' } }, 'app'), 'Could not import');
});

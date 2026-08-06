import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFallbackShapeAgentDraft,
  normalizeShapeAgentDraft,
  parseShapeAgentDraftJson,
  parseShapeResources,
} from '../src/kordi-app/agents/shapeAgentDraft';
import { buildShapeAgentDraftPrompt } from '../src/kordi-app/agents/shapeAgentPrompts';

test('parseShapeResources classifies urls files and text from newline or comma input', () => {
  const resources = parseShapeResources('https://docs.example.com, ./handbook.md\nA support agent for our docs');

  assert.deepEqual(resources, [
    { kind: 'url', value: 'https://docs.example.com' },
    { kind: 'file', value: './handbook.md' },
    { kind: 'text', value: 'A support agent for our docs' },
  ]);
});

test('normalizeShapeAgentDraft requires core fields and cleans arrays', () => {
  const draft = normalizeShapeAgentDraft({
    name: ' Docs Helper ',
    role: ' Technical Support Agent ',
    description: ' Helps with docs ',
    systemPrompt: ' Use docs only. ',
    sourceSummary: ' Description only ',
    boundaries: [' No account access ', '', 'No account access'],
    skills: [{ name: ' navigate-knowledge ', description: ' Search docs ' }, { name: '', description: 'bad' }],
  });

  assert.equal(draft?.name, 'Docs Helper');
  assert.deepEqual(draft?.boundaries, ['No account access']);
  assert.deepEqual(draft?.skills, [{ name: 'navigate-knowledge', description: 'Search docs' }]);
  assert.equal(normalizeShapeAgentDraft({ ...draft, name: '' }), null);
  assert.equal(normalizeShapeAgentDraft({ ...draft, role: '' }), null);
  assert.equal(normalizeShapeAgentDraft({ ...draft, systemPrompt: '' }), null);
});

test('parseShapeAgentDraftJson handles fenced json and rejects malformed model output', () => {
  const parsed = parseShapeAgentDraftJson('```json\n{"name":"Docs Helper","role":"Support","description":"Helps","systemPrompt":"Use docs","sourceSummary":"Docs","boundaries":["Be honest"],"skills":[{"name":"navigate-knowledge","description":"Search docs"}]}\n```');

  assert.equal(parsed?.name, 'Docs Helper');
  assert.equal(parseShapeAgentDraftJson('not json'), null);
  assert.equal(parseShapeAgentDraftJson('{"name":"Missing prompt"}'), null);
});

test('buildFallbackShapeAgentDraft creates a usable private agent draft from inputs', () => {
  const draft = buildFallbackShapeAgentDraft({
    resources: [{ kind: 'url', value: 'https://docs.example.com' }],
    identity: 'A technical support helper for docs.',
  });

  assert.equal(draft.name, 'Technical Support Helper');
  assert.match(draft.systemPrompt, /private agent/i);
  assert.doesNotMatch(draft.systemPrompt, /private Cloud agent/i);
  assert.match(draft.sourceSummary, /https:\/\/docs\.example\.com/);
  assert.ok(draft.skills.some((skill) => skill.name === 'navigate-knowledge'));
});

test('buildShapeAgentDraftPrompt includes private cloud access and shape output contract', () => {
  const prompt = buildShapeAgentDraftPrompt({
    resources: [
      { kind: 'url', value: 'https://docs.example.com' },
      { kind: 'text', value: 'Internal docs helper' },
    ],
    identity: 'A technical support agent for product docs.',
  });

  assert.match(prompt, /private to the creator's Cloud account/i);
  assert.match(prompt, /customer support/i);
  assert.match(prompt, /technical support/i);
  assert.match(prompt, /Return only JSON/i);
  assert.match(prompt, /https:\/\/docs\.example\.com/);
  assert.match(prompt, /A technical support agent for product docs\./);
  assert.match(prompt, /"systemPrompt"/);
});

test('buildShapeAgentDraftPrompt includes existing Kordi creator tools and skills', () => {
  const prompt = buildShapeAgentDraftPrompt({
    resources: [{ kind: 'text', value: 'Project agent' }],
    identity: 'Push development forward.',
    creatorAgent: {
      name: 'Kordi',
      role: 'My agent',
      systemPrompt: 'You are an expert coding assistant.',
      loadedTools: ['read', 'bash', 'edit'],
      loadedSkills: ['brainstorming', 'test-driven-development'],
      identityFiles: ['AGENTS.md'],
    },
  });

  assert.match(prompt, /Existing creator Agent/i);
  assert.match(prompt, /Name: Kordi/);
  assert.match(prompt, /Tools available to the creator during shaping: read, bash, edit/);
  assert.match(prompt, /Skills available to the creator during shaping: brainstorming, test-driven-development/);
  assert.match(prompt, /Identity files visible to the creator: AGENTS\.md/);
  assert.match(prompt, /Use the creator Agent's available tools and skills to shape the draft/i);
});

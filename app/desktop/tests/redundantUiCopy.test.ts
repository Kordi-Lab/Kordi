import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

function readTsxSources(directory: string): Array<{ path: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readTsxSources(path);
    if (!entry.isFile() || !entry.name.endsWith('.tsx')) return [];
    return [{ path, source: readFileSync(path, 'utf8') }];
  });
}

test('desktop surfaces do not narrate obvious product structure or adjacent controls', () => {
  const sources = readTsxSources(sourceRoot);
  const forbiddenCopy = [
    'People open as one flat chat; groups expand into sessions.',
    'Each row is a # session with one of your agents.',
    'workspaces with shared context and sessions',
    'Compact messenger-style contacts. Select a row to view details.',
    'Projects should start explicitly from the + menu, not from ordinary chats.',
    'Normal sessions stay in Chats by default.',
    'Start with one provider. Save more later',
    'These defaults apply before per-chat or per-project overrides',
    'If the shell feels too heavy or too dense',
    'Choose the primary interface palette.',
    'Primary interface palette for the app.',
    'Use cloud APIs or local models to start chatting.',
    'You can find this setting anytime in Settings → Authentication.',
    'Connect model providers, manage saved accounts and optional keys',
    'Pick a provider. One working connection is enough.',
    'Enter chat now, or add another source.',
    'Enter chat now, or configure another source',
    'Choose who this conversation is with.',
    'Direct contact conversation',
    'Start with one Kordi agent',
    'Stable group with people only',
    'Request a private Kordi account',
    'Agents are added later.',
    'Choose the provider, model, and thinking level.',
    'Find other Kordi cloud users by their account ID.',
    'Search by exact account ID, then send an approval request.',
    'Send an approval request to start chatting after they accept.',
    'Enter the account ID your contact shared with you.',
    'Build agents, skills, tools, and workflows',
    'Review the skills, tools, and plugins available to this agent.',
    'Preview and edit supported workspace files without leaving Kordi Factory.',
    'Review the files used to validate, test, and publish this build.',
    'Publishing stays locked until the current files pass validation',
    'See real direct reachouts and runtime activity',
    'Review saved and published changes.',
    'Choose what to add to this draft.',
    'Rename this capability in the draft.',
    'Choose the default route, fallback, and thinking level for this agent.',
    'Build, inspect, and install reusable capabilities.',
    'Kordi shapes the private Agent with its configured LLM provider',
    "Uses Kordi's configured LLM provider and current tool/skill context",
    'Output follows the Cloud Agent definition schema.',
    'Shape prepares the draft. Create saves it with the selected Cloud access.',
    'Browse the full project folder. Open folders to inspect their files',
    'Choose a new title for',
    'out of Chats and into an explicit project folder.',
    'Projects group sessions by a shared local folder.',
    'Upload a custom image for your local human identity.',
    'Recent saved changes, shown in file path style.',
    'Backbone/default auth source + model, fallback auth source + model',
    'Use the default model for inbound mentions and reach-outs.',
    'Choose the default and fallback now.',
    'Saved locally until this agent is connected to hosted collaboration',
    'People contacting this agent directly appear here instead of in your person chats.',
    'Approved contacts only',
  ];

  for (const copy of forbiddenCopy) {
    const match = sources.find(({ source }) => source.includes(copy));
    assert.equal(match, undefined, `${copy} should not appear in ${match?.path ?? 'desktop source'}`);
  }
});

test('copy cleanup preserves operational guidance and recovery states', () => {
  const readSource = (path: string) => readFileSync(join(sourceRoot, path), 'utf8');

  assert.match(readSource('pages/ChatCreateDialog.tsx'), /Select at least 2 contacts\./);
  assert.match(readSource('pages/SessionActionOverlays.tsx'), /Use a folder path without spaces\./);
  assert.match(readSource('pages/chatsPage.mainWorkspace.tsx'), /No provider connected yet/);
  assert.match(
    readSource('kordi-app/cloud/CloudSocialUnavailableNotice.tsx'),
    /Google and GitHub sign-in aren’t available on this server\. Use email and password\./,
  );
});

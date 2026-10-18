import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { Editor as TiptapEditor } from '@tiptap/core';

import { installEditorDom } from './helpers/editorDom';

let restore: () => void = () => undefined;
let Editor: typeof import('@tiptap/core').Editor;
let extensions: typeof import('../src/features/documents/editor/documentEditorExtensions');
let ids: typeof import('../src/features/documents/editor/documentBlockIds');
let sync: typeof import('../src/features/documents/editor/documentEditorSync');

before(async () => {
  restore = installEditorDom();
  ({ Editor } = await import('@tiptap/core'));
  extensions = await import('../src/features/documents/editor/documentEditorExtensions');
  ids = await import('../src/features/documents/editor/documentBlockIds');
  sync = await import('../src/features/documents/editor/documentEditorSync');
});
after(() => restore());

const withoutIds = (markdown: string) => markdown.replace(/\n<!-- k:[A-Za-z0-9_-]+ -->/g, '');

/** Opens Markdown the way the reader does (block by block) and returns what a save would write, without id comments. */
function roundTrip(markdown: string) {
  const editor = new Editor({ extensions: extensions.documentEditorExtensions() });
  try {
    sync.loadBlocks(editor, ids.blocksFromSource(markdown), {});
    return { markdown: markdownOf(editor), json: editor.getJSON() };
  } finally {
    editor.destroy();
  }
}

const markdownOf = (editor: TiptapEditor) => withoutIds(ids.sourceOfBlocks(ids.serializeBlocks(editor.markdown!, editor.getJSON())));

/** A plan an agent might write with `create_document`: every common construct, all of which the schema takes as is. */
const AGENT_PLAN = [
  '# Release plan',
  '## Owners',
  '- **Build:** the desktop team\n- **Docs:** the writing team, see [the guide](https://example.com/guide)',
  '## Steps',
  '1. Prepare the branch\n   - Update the changelog\n   - Bump the version\n2. Run the checks',
  '## Open tasks',
  '- [ ] Draft the announcement\n- [x] Freeze the feature list\n  - [ ] Confirm with support',
  '> Ship only after the checks pass.',
  '| Step  | Owner   |\n| ----- | ------- |\n| Build | Desktop |',
  '```bash\npnpm test\n```',
].join('\n\n');

/**
 * Markdown that used to throw "Invalid content for node listItem" (or paragraph) and black out the app.
 * Each opens now; `saved` is what a later save writes for it, the documented normalization.
 */
const PROBLEM_SAMPLES: { name: string; source: string; saved: string }[] = [
  { name: 'an item that starts with a heading', source: '- ## Summary\n  The short version.', saved: '-\n  ## Summary\n\n  The short version.' },
  { name: 'an item that starts with a nested list', source: '- - First idea\n  - Second idea', saved: '-\n  - First idea\n  - Second idea' },
  { name: 'an item that starts with a fenced code block', source: '- ```bash\n  pnpm build\n  ```', saved: '-\n  ```bash\n  pnpm build\n  ```' },
  { name: 'an item that starts with indented code', source: '-     make all', saved: '-\n  ```\n  make all\n  ```' },
  { name: 'an item that starts with a quote', source: '- > Worth repeating', saved: '-\n  > Worth repeating' },
  { name: 'an item that is only an image', source: '- ![Diagram](https://example.com/diagram.png)', saved: '- ![Diagram](https://example.com/diagram.png)' },
  { name: 'an item whose first line is empty', source: '-\n  ## Later heading', saved: '-\n  ## Later heading' },
];

test('Markdown an agent writes opens and saves back unchanged', () => {
  assert.equal(roundTrip(AGENT_PLAN).markdown, AGENT_PLAN);
});

test('list items the schema refuses open instead of throwing, and save in the documented form', () => {
  for (const sample of PROBLEM_SAMPLES) {
    const editor = new Editor({ extensions: extensions.documentEditorExtensions() });
    try {
      // The unfitted parse is what used to reach the editor: it fails the schema's checks.
      const raw = editor.markdown!.parse(sample.source);
      assert.throws(() => editor.schema.nodeFromJSON(raw).check(), /Invalid content for node/, sample.name);
      assert.doesNotThrow(() => sync.loadBlocks(editor, ids.blocksFromSource(sample.source), {}), sample.name);
      assert.doesNotThrow(() => editor.state.doc.check(), sample.name);
      assert.equal(markdownOf(editor), sample.saved, sample.name);
    } finally {
      editor.destroy();
    }
    // The saved form opens to the same document again: normalizing once is stable.
    assert.equal(roundTrip(sample.saved).markdown, sample.saved, `${sample.name} (saved form)`);
  }
});

test('the fitted item keeps the block it started with after an empty paragraph', () => {
  const { json } = roundTrip('- ## Summary\n  The short version.');
  const item = json.content?.[0]?.content?.[0];
  assert.equal(item?.type, 'listItem');
  assert.deepEqual(item?.content?.map((node) => node.type), ['paragraph', 'heading', 'paragraph']);
  assert.equal(item?.content?.[0]?.content, undefined, 'the leading paragraph is empty');
});

test('a whole agent document with the problem items opens, other blocks untouched', () => {
  // A paragraph between samples keeps neighboring lists from joining into one.
  const source = [AGENT_PLAN, ...PROBLEM_SAMPLES.map((sample) => sample.source)].join('\n\nNext.\n\n');
  const saved = [AGENT_PLAN, ...PROBLEM_SAMPLES.map((sample) => sample.saved)].join('\n\nNext.\n\n');
  assert.equal(roundTrip(source).markdown, saved);
});

test('other constructs inside items keep opening the way they did', () => {
  const samples = [
    '- one\n-\n- three',
    '- [ ] open\n- [x] done',
    '- Results:\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |',
    '- <b>bold html</b> item',
    '1. Run this:\n\n   ```bash\n   pnpm test\n   ```',
  ];
  for (const source of samples) {
    const editor = new Editor({ extensions: extensions.documentEditorExtensions() });
    try {
      assert.doesNotThrow(() => sync.loadBlocks(editor, ids.blocksFromSource(source), {}), source);
      assert.doesNotThrow(() => editor.state.doc.check(), source);
    } finally {
      editor.destroy();
    }
  }
  // An empty item keeps its bare marker instead of gaining a trailing space.
  assert.equal(roundTrip('- one\n-\n- three').markdown, '- one\n-\n- three');
});

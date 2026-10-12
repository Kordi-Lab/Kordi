import { splitMarkdownBlocks } from '../../src/features/documents/documentBlocks';
import type { DocumentShareApi, DocumentWriteTarget } from '../../src/features/documents/documentShareApi';
import type {
  DocumentComment,
  DocumentReaction,
  DocumentResponse,
  DocumentShare,
} from '../../src/features/documents/documentShareTypes';

export const SAMPLE_TOKEN = 'kordi_ds_EXAMPLEtokenEXAMPLEtokenEXAMPLEtoken0';

export const SAMPLE_HTML = '<!doctype html><html><body><h1>Lab notes</h1><p>Shared as HTML.</p></body></html>';

export const SAMPLE_MARKDOWN = [
  '# Kordi related work',
  '## Summary',
  'Most published work on agents in human groups studies one shared agent inside a group of people. Kordi, where every person brings their own agent into a shared conversation, has no end-to-end prior study.',
  'That configuration is the clearest niche for Kordi, and it inherits the hardest open problem: keeping each person\'s private context from leaking across users.',
  '## Coordination theory',
  '- Coordination is the management of dependencies between activities.\n- Grounding: collaborators keep checking mutual understanding.\n- Awareness: knowing what others are doing.',
  '| Paper | Method |\n| --- | --- |\n| Human-agent collaboration | Framework |\n| The collaboration gap | 16 interviews |',
  'Turn-taking in a group with several agents is the technical core.',
].join('\n\n');

const ALEX = { accountId: 'acct_example_alex', displayName: 'Alex Morgan', kordiId: '123456789', avatarUrl: null };

function reaction(blockId: string, emoji: string, name: string, mine = false): DocumentReaction {
  return {
    reactionId: `react_${blockId}_${name}`,
    blockId,
    reaction: emoji,
    actor: { accountId: mine ? ALEX.accountId : null, readerKey: null, displayName: name },
    mine,
    createdAt: '2026-10-09T10:10:00Z',
  };
}

function comment(overrides: Partial<DocumentComment> & Pick<DocumentComment, 'commentId' | 'blockId' | 'body'>): DocumentComment {
  return {
    parentCommentId: null,
    author: { accountId: 'acct_example_priya', displayName: 'Priya', kordiId: null, avatarUrl: null },
    mentionsAgent: false,
    mine: false,
    createdAt: '2026-10-09T10:15:00Z',
    editedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

export function sampleShare(overrides: Partial<DocumentShare> = {}): DocumentShare {
  return {
    shareId: 'docshare_example',
    attachmentId: 'att_example_doc',
    shareUrl: `https://kordi.ai/d/${SAMPLE_TOKEN}`,
    deepLink: `kordi://document/${SAMPLE_TOKEN}`,
    accessMode: 'link',
    readersCanAskAgent: true,
    createdAt: '2026-10-09T10:00:00Z',
    revokedAt: null,
    ...overrides,
  };
}

export function sampleDocument(viewer: DocumentResponse['viewer'] = 'owner'): DocumentResponse {
  const blocks = splitMarkdownBlocks(SAMPLE_MARKDOWN).map((block) => ({ id: block.id, source: block.source, html: '' }));
  return {
    attachmentId: 'att_example_doc',
    title: 'Kordi related work',
    fileName: 'related-work.md',
    format: 'markdown',
    contentType: 'text/markdown',
    sizeBytes: 18_400,
    createdAt: '2026-10-09T09:31:00Z',
    updatedAt: '2026-10-09T09:31:00Z',
    sessionId: 'session_example',
    sessionTitle: 'Related work',
    author: ALEX,
    agent: { displayName: 'Lab agent' },
    blocks,
    rawPath: null,
    reactions: [reaction('b3', '❤️', 'Priya'), reaction('b3', '👍', 'Theo'), reaction('b3', '👍', 'Alex Morgan', viewer === 'owner')],
    comments: [
      comment({ commentId: 'doccmt_1', blockId: 'b3', body: '@Lab agent what does "clearest niche" mean here?', mentionsAgent: true }),
      comment({
        commentId: 'doccmt_2',
        blockId: 'b6',
        body: 'Can we add the interview count to the summary?',
        author: { accountId: ALEX.accountId, displayName: 'Alex Morgan', kordiId: '123456789', avatarUrl: null },
        mine: viewer === 'owner',
      }),
      comment({ commentId: 'doccmt_3', blockId: 'b6', parentCommentId: 'doccmt_2', body: 'Yes, 16 interviews.', createdAt: '2026-10-09T10:20:00Z' }),
      comment({ commentId: 'doccmt_4', blockId: 'b1', body: 'Resolved thread', resolvedAt: '2026-10-09T10:30:00Z' }),
    ],
    revision: 3,
    share: viewer === 'owner' ? sampleShare() : null,
    viewer,
    viewerCan: { share: viewer === 'owner', react: true, comment: true, askAgent: true, edit: viewer !== 'public' },
  };
}

export function sampleHtmlDocument(viewer: DocumentResponse['viewer'] = 'owner'): DocumentResponse {
  return {
    ...sampleDocument(viewer),
    attachmentId: 'att_example_html',
    title: 'Lab notes',
    fileName: 'lab-notes.html',
    format: 'html',
    contentType: 'text/html',
    blocks: [{ id: 'b0', source: '', html: '' }],
    rawPath: viewer === 'public' ? `/d/${SAMPLE_TOKEN}/raw` : '/v1/cloud/documents/att_example_html/raw',
    reactions: [],
    comments: [],
    viewerCan: { share: viewer === 'owner', react: true, comment: true, askAgent: true, edit: false },
  };
}

export type RecordedCall = { method: string; args: unknown[] };

export type MemoryDocumentApiOptions = {
  /** Server-side document the next save conflicts with (409), once. */
  conflictWith?: DocumentResponse;
};

/** In-memory document routes with recorded calls. Saves bump the revision and re-split the blocks. */
export function createMemoryDocumentApi(document: DocumentResponse = sampleDocument(), latencyMs = 0, options: MemoryDocumentApiOptions = {}) {
  const calls: RecordedCall[] = [];
  let stored = document;
  let conflict = options.conflictWith ?? null;
  let reactions = [...document.reactions];
  let share: DocumentShare | null = document.share;
  const wait = () => new Promise<void>((resolve) => { setTimeout(resolve, latencyMs); });
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
  const api = {
    async getDocument(attachmentId) { record('getDocument', attachmentId); await wait(); return { ...stored, reactions, share }; },
    async saveDocumentContent(attachmentId, input) {
      record('saveDocumentContent', attachmentId, input);
      await wait();
      if (conflict) {
        stored = conflict;
        conflict = null;
        return { status: 'conflict' as const, document: stored };
      }
      if (input.baseRevision !== (stored.revision ?? 0)) return { status: 'conflict' as const, document: stored };
      const blocks = splitMarkdownBlocks(input.source).map((block) => ({ id: block.id, source: block.source, html: '' }));
      stored = { ...stored, blocks, revision: (stored.revision ?? 0) + 1 };
      return { status: 'saved' as const, document: { ...stored, reactions, share } };
    },
    setStored(next: DocumentResponse) { stored = next; },
    async getPublicDocument(token) { record('getPublicDocument', token); await wait(); return { ...document, viewer: 'public', share: null, viewerCan: { share: false, react: true, comment: true, askAgent: true } }; },
    async getDocumentRaw(attachmentId) { record('getDocumentRaw', attachmentId); await wait(); return SAMPLE_HTML; },
    async getPublicDocumentRaw(rawPath) { record('getPublicDocumentRaw', rawPath); await wait(); return SAMPLE_HTML; },
    async listShares(attachmentId) { record('listShares', attachmentId); return share ? [share] : []; },
    async createShare(attachmentId, input) { record('createShare', attachmentId, input); await wait(); share = sampleShare({ attachmentId }); return share; },
    async updateShare(shareId, input) { record('updateShare', shareId, input); share = sampleShare({ ...share, ...input }); return share; },
    async revokeShare(shareId) { record('revokeShare', shareId); share = null; },
    async toggleReaction(target: DocumentWriteTarget, input) {
      record('toggleReaction', target, input);
      const own = reactions.find((entry) => entry.blockId === input.blockId && entry.reaction === input.reaction && entry.mine);
      reactions = own
        ? reactions.filter((entry) => entry !== own)
        : [...reactions, reaction(input.blockId, input.reaction, 'Alex Morgan', true)];
      return reactions.filter((entry) => entry.blockId === input.blockId);
    },
    async createComment(target, input) {
      record('createComment', target, input);
      return comment({ commentId: `doccmt_new_${calls.length}`, blockId: input.blockId, body: input.body, parentCommentId: input.parentCommentId ?? null, mine: true, createdAt: new Date().toISOString() });
    },
    async updateComment(commentId, input) {
      record('updateComment', commentId, input);
      const current = document.comments.find((entry) => entry.commentId === commentId) ?? comment({ commentId, blockId: 'b0', body: '' });
      return { ...current, body: input.body ?? current.body, resolvedAt: input.resolved ? new Date().toISOString() : current.resolvedAt };
    },
    async deleteComment(commentId) { record('deleteComment', commentId); },
    async uploadDocument(path, contentType) { record('uploadDocument', path, contentType); await wait(); return { attachmentId: 'att_example_doc', sizeBytes: 18_400 }; },
    rawDocumentUrl: (rawPath: string) => `https://kordi.example${rawPath}`,
  } satisfies DocumentShareApi & { setStored(next: DocumentResponse): void };
  return { api, calls };
}

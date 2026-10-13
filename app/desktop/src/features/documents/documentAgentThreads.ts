import type { CommentThread } from './documentReaderModel';
import type { DocumentComment } from './documentShareTypes';

export type AgentRunLine = 'working' | 'failed' | null;

export function isPersonComment(comment: DocumentComment) {
  return comment.kind !== 'agent' && comment.kind !== 'system';
}

function threadComments(thread: CommentThread) {
  return [thread.root, ...thread.replies];
}

/**
 * What a comment that asked an agent shows under it. The run status decides;
 * a server without run statuses falls back to "the newest comment asks the agent".
 */
export function agentRunLine(thread: CommentThread, comment: DocumentComment): AgentRunLine {
  if (!isPersonComment(comment)) return null;
  const comments = threadComments(thread);
  const run = comment.agentRun;
  if (run === undefined) {
    return comment.mentionsAgent && comments[comments.length - 1].commentId === comment.commentId ? 'working' : null;
  }
  if (!run) return null;
  if (run.status === 'queued' || run.status === 'running') return 'working';
  if (run.status !== 'failed') return null;
  // Asked again already: the newer comment carries the state.
  const later = comments.slice(comments.indexOf(comment) + 1);
  return later.some((entry) => isPersonComment(entry) && entry.body === comment.body) ? null : 'failed';
}

/** The server's notice after a failed run repeats the "Could not answer" line of the comment that asked. */
export function isFailedRunNotice(thread: CommentThread, comment: DocumentComment) {
  if (comment.kind !== 'system') return false;
  const comments = threadComments(thread);
  const asked = comments.slice(0, comments.indexOf(comment)).reverse().find(isPersonComment);
  return asked?.agentRun?.status === 'failed';
}

/** The agent a comment mentions first, out of the known agent names. */
export function mentionedAgentName(body: string, agentNames: string[]) {
  let found: { name: string; index: number } | null = null;
  for (const name of [...agentNames].sort((left, right) => right.length - left.length)) {
    const index = name ? body.indexOf(`@${name}`) : -1;
    if (index >= 0 && (!found || index < found.index)) found = { name, index };
  }
  return found?.name ?? null;
}

/** The agent that answered last in the thread. */
export function threadAgentName(thread: CommentThread) {
  const reply = [...thread.replies].reverse().find((entry) => entry.kind === 'agent');
  return reply?.author.displayName.trim() || null;
}

/** The document owner and the person who asked may delete an agent reply. */
export function canDeleteAgentReply(thread: CommentThread, reply: DocumentComment, viewerIsOwner: boolean) {
  if (viewerIsOwner) return true;
  const comments = threadComments(thread);
  const before = comments.slice(0, comments.indexOf(reply)).reverse();
  return Boolean(before.find((entry) => isPersonComment(entry) && entry.mentionsAgent)?.mine);
}

/**
 * The `@` picker: the viewer's own agents, then other agents in the session, then people.
 * A reader on a share link is offered only the document's agent.
 */
export function documentMentionOptions({ agentName, agents = [], people, isPublic }: {
  /** The document's agent (else the session's), when the viewer may ask it. */
  agentName: string | null;
  agents?: { name: string; mine: boolean }[];
  people: string[];
  isPublic: boolean;
}): { name: string; kind: 'agent' | 'person' }[] {
  const agentNames = isPublic
    ? [agentName]
    : [
        ...agents.filter((agent) => agent.mine).map((agent) => agent.name),
        ...(agents.some((agent) => agent.name === agentName) ? [] : [agentName]),
        ...agents.filter((agent) => !agent.mine).map((agent) => agent.name),
      ];
  const unique = [...new Set(agentNames.filter((name): name is string => Boolean(name)))];
  return [
    ...unique.map((name) => ({ name, kind: 'agent' as const })),
    ...(isPublic ? [] : people.map((name) => ({ name, kind: 'person' as const }))),
  ];
}

export function prefixMention(draft: string, name: string) {
  const mention = `@${name} `;
  return draft.startsWith(mention) ? draft : `${mention}${draft.trimStart()}`;
}

/** A run that ended this recently still owns a content update that arrives after it. */
export const AGENT_EDIT_WINDOW_MS = 15_000;

export type AgentThreadState = {
  /** Runs seen queued or running while the document was open, by mentioning comment. */
  runs: Record<string, { rootId: string; endedAt: number | null }>;
  /** Thread root id to the agent whose edit arrived during that thread's run. */
  edits: Record<string, string>;
  revision: number;
};

export const EMPTY_AGENT_THREADS: AgentThreadState = { runs: {}, edits: {}, revision: 0 };

/**
 * Follows the runs of a document's threads across refreshes. A newer revision
 * that names an agent marks the threads whose run is active or just ended.
 */
export function advanceAgentThreads(
  state: AgentThreadState,
  next: { comments: DocumentComment[]; revision?: number; updatedByAgentName?: string | null },
  now: number,
): AgentThreadState {
  const runs = { ...state.runs };
  for (const comment of next.comments) {
    const status = comment.agentRun?.status;
    const known = runs[comment.commentId];
    if (status === 'queued' || status === 'running') {
      if (!known || known.endedAt !== null) runs[comment.commentId] = { rootId: comment.parentCommentId ?? comment.commentId, endedAt: null };
    } else if (known && known.endedAt === null) {
      if (status === 'completed') runs[comment.commentId] = { ...known, endedAt: now };
      else delete runs[comment.commentId];
    }
  }
  const revision = next.revision ?? state.revision;
  if (revision <= state.revision) return { ...state, runs };
  const agentName = next.updatedByAgentName?.trim();
  const edits = { ...state.edits };
  if (agentName) {
    for (const run of Object.values(runs)) {
      if (run.endedAt === null || now - run.endedAt <= AGENT_EDIT_WINDOW_MS) edits[run.rootId] = agentName;
    }
  }
  return { runs, edits, revision };
}

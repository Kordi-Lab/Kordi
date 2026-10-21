import type { DesktopChatTurnSnapshot, DesktopChatToolSnapshot } from '../types';
import { toolTimelineToolLabel, formatRunningElapsed } from './toolTimeline';

export function progressAction(tool: DesktopChatToolSnapshot) {
  const label = toolTimelineToolLabel(tool);
  const actions: Record<string, string> = {
    'Read file': 'Reading files', 'Read context': 'Reading context', 'Inspect file': 'Reading files',
    'Search code': 'Searching the codebase', 'Find files': 'Finding files', 'List files': 'Finding files',
    'Run tests': 'Running tests', 'Run lint': 'Running lint', 'Run typecheck': 'Checking types',
    'Build project': 'Building the project', 'Run script': 'Running a command', 'Edit file': 'Editing files',
    'Edit files': 'Editing files', 'Fetch web page': 'Reading a web page', 'Inspect image': 'Inspecting an image',
    'Inspect repository': 'Inspecting the repository', 'Update plan': 'Updating the plan',
  };
  return actions[label] ?? 'Using tools';
}

export function progressToolIsActive(tool: DesktopChatToolSnapshot) {
  return !tool.isError && !['done', 'complete', 'completed', 'success', 'succeeded', 'error', 'failed', 'cancelled', 'canceled'].includes(tool.status.toLowerCase());
}

export function elapsedLabel(turn: DesktopChatTurnSnapshot, now: number) {
  if (turn.startedAtMs == null || !Number.isFinite(turn.startedAtMs)) return null;
  const end = turn.completed ? turn.completedAtMs : now;
  if (end == null || !Number.isFinite(end)) return null;
  return formatRunningElapsed(Math.max(0, end - turn.startedAtMs));
}

export function turnProgressLabel(turn: DesktopChatTurnSnapshot) {
  if (turn.status === 'cancelling') return 'Stopping…';
  if (turn.status === 'cancelled') return 'Stopped';
  if (turn.status === 'retrying') return 'Retrying…';
  if (turn.status === 'compacting') return 'Compressing conversation…';
  if (turn.status === 'failed' || (turn.completed && !turn.succeeded)) return 'Needs attention';
  if (turn.completed) return 'Worked for';
  if (['waiting', 'waiting-approval', 'waiting_approval'].includes(turn.status)) return 'Waiting for approval';
  if (turn.status === 'queued') return 'Queued';
  const active = turn.tools.filter(progressToolIsActive);
  if (active.length) return `${progressAction(active[0])}${active.length > 1 ? ` · ${active.length} active` : ''}`;
  return turn.status === 'writing' ? 'Writing the response' : 'Working';
}

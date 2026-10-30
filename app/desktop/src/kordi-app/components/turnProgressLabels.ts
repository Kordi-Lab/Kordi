import type { DesktopChatTurnSnapshot, DesktopChatToolSnapshot } from '../types';
import { toolTimelineToolLabel, formatRunningElapsed } from './toolTimeline';

export function progressAction(tool: DesktopChatToolSnapshot) {
  const label = toolTimelineToolLabel(tool);
  const actions: Record<string, string> = {
    'Check disk usage': 'Checking disk usage', 'Check working directory': 'Checking the working directory',
    'Search web': 'Searching the web', 'Update repository': 'Updating the repository',
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
  if (end == null || !Number.isFinite(end) || end < turn.startedAtMs) return null;
  return formatRunningElapsed(Math.max(0, end - turn.startedAtMs));
}

export function turnProgressLabel(turn: DesktopChatTurnSnapshot) {
  if (turn.status === 'cancelling') return 'Stopping…';
  if (turn.status === 'cancelled') return 'Stopped';
  if (turn.status === 'retrying') return 'Retrying…';
  if (turn.status === 'compacting') return 'Compressing conversation…';
  if (turn.status === 'failed' || (turn.completed && !turn.succeeded)) return 'Needs attention';
  if (!turn.completed && turn.agentExchangeStatus) return turn.agentExchangeStatus === 'waiting' ? 'Waiting for reply' : 'Processing reply';
  if (turn.completed) return elapsedLabel(turn, 0) ? 'Worked for' : 'Finished';
  if (['waiting', 'waiting-approval', 'waiting_approval'].includes(turn.status)) return 'Waiting for approval';
  if (turn.hostedRunStatus === 'leased') return 'Starting…';
  if (turn.status === 'queued' || turn.hostedRunStatus === 'queued') return 'Queued…';
  if (turn.pendingCollaborationAgentRequest && !turn.localExecutionStarted && !turn.tools.length && !turn.thinkingText) return 'Waiting for agent';
  const active = turn.tools.filter(progressToolIsActive);
  if (active.length) {
    const actions = [...new Set(active.map(progressAction))];
    return actions.slice(0, 2).map((action, index) => index ? action.charAt(0).toLowerCase() + action.slice(1) : action).join(', ') + (actions.length > 2 ? ` +${actions.length - 2}` : '');
  }
  if (turn.status === 'thinking') return 'Thinking';
  return turn.status === 'writing' ? 'Writing the response' : 'Working';
}

/** Action summaries describe observed tools, never infer a model's private reasoning. */
export function settledProgressLabel(tools: DesktopChatToolSnapshot[], unavailable = 0) {
  const labels: Record<string, string> = {
    'Check disk usage': 'Checked disk usage', 'Check working directory': 'Checked the working directory',
    'Search web': 'Searched the web', 'Update repository': 'Updated the repository',
    'Read file': 'Read files', 'Read context': 'Read context', 'Inspect file': 'Read files',
    'Search code': 'Searched the codebase', 'Find files': 'Found files', 'List files': 'Listed files',
    'Run tests': 'Ran tests', 'Run lint': 'Ran lint', 'Run typecheck': 'Checked types',
    'Build project': 'Built the project', 'Run script': 'Ran commands', 'Edit file': 'Edited files',
    'Edit files': 'Edited files', 'Fetch web page': 'Read web pages', 'Inspect image': 'Inspected images',
    'Inspect repository': 'Inspected the repository', 'Update plan': 'Updated the plan',
  };
  const actions = [...new Set(tools.map(tool => labels[toolTimelineToolLabel(tool)] ?? 'Used tools'))];
  if (unavailable) actions.push('Earlier activity');
  if (!actions.length) return 'Activity';
  const visible = actions.slice(0, 3).map((action, i) => i ? action.charAt(0).toLowerCase() + action.slice(1) : action);
  return visible.join(', ') + (actions.length > 3 ? ` +${actions.length - 3}` : '');
}

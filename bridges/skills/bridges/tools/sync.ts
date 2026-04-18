import { bridgesCli } from './shared.js';
import type { ToolDefinition } from './shared.js';

export const syncProject: ToolDefinition = {
  name: 'sync_project',
  description: 'Optionally sync the current project checkout\'s shared workspace files with remote state.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID (proj_...)' },
      approveUnmanaged: {
        type: 'boolean',
        description: 'Approve a risky sync involving unmanaged paths after reviewing the proposal',
      },
    },
    required: ['projectId'],
  },
  async execute(params) {
    const args = ['sync', '--project', params.projectId as string];
    if (params.approveUnmanaged) args.push('--approve-unmanaged');
    const output = await bridgesCli(args);
    return { success: true, output };
  },
};

export const getChanges: ToolDefinition = {
  name: 'sync_proposal',
  description: 'Read the local approval proposal generated for a risky optional workspace sync.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const proposal = await import('node:fs/promises').then(({ readFile }) =>
      readFile(`${dir}/.bridges/sync-approval.json`, 'utf-8')
    ).catch(() => '');
    return { proposal };
  },
};

export const tools = [syncProject, getChanges];

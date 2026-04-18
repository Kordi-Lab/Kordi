import { bridgesCli } from './shared.js';
import type { ToolDefinition } from './shared.js';

export const projectInit: ToolDefinition = {
  name: 'project_create',
  description: 'Create a Bridges project and return the server project ID.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Project name',
      },
      description: {
        type: 'string',
        description: 'Optional project description',
      },
    },
    required: ['name'],
  },
  async execute(params) {
    const args = ['create', params.name as string];
    if (params.description) args.push('--description', params.description as string);
    const output = await bridgesCli(args);
    return { success: true, output };
  },
};

export const projectInvite: ToolDefinition = {
  name: 'project_invite',
  description: 'Generate a shareable invite string for another agent to join this project.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID to invite into (proj_...)' },
    },
    required: ['projectId'],
  },
  async execute(params) {
    const args = ['invite', '--project', params.projectId as string];
    const output = await bridgesCli(args);
    const shareableInvite = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('bridges://join/'));
    return {
      success: true,
      invite: shareableInvite ?? output,
      output,
    };
  },
};

export const projectJoin: ToolDefinition = {
  name: 'project_join',
  description: 'Join a project using either a shareable invite string or a raw token + project ID.',
  parameters: {
    type: 'object',
    properties: {
      invite: {
        type: 'string',
        description: 'Shareable invite string (`bridges://join/...`) or raw invite token',
      },
      projectId: {
        type: 'string',
        description: 'Project ID to join (required only when using a raw invite token)',
      },
    },
    required: ['invite'],
  },
  async execute(params) {
    const args = ['join'];
    if (params.projectId) args.push('--project', params.projectId as string);
    args.push(params.invite as string);
    const output = await bridgesCli(args);
    return { success: true, output };
  },
};

export const projectList: ToolDefinition = {
  name: 'project_status',
  description: 'Show current Bridges status, including configured projects.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const output = await bridgesCli(['status']);
    return { output };
  },
};

export const tools = [projectInit, projectInvite, projectJoin, projectList];

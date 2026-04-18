import { bridgesCli } from './shared.js';
import type { ToolDefinition } from './shared.js';

export const listMembers: ToolDefinition = {
  name: 'list_members',
  description: 'List project members through the current Bridges CLI.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID (proj_...)' },
    },
    required: ['projectId'],
  },
  async execute(params) {
    const output = await bridgesCli([
      'members',
      '--project',
      params.projectId as string,
    ]);
    return { success: true, output };
  },
};

export const memberSkills: ToolDefinition = {
  name: 'member_skills',
  description: 'Legacy helper. Agent skill discovery is not exposed by the current CLI.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID (proj_...)' },
    },
    required: ['projectId'],
  },
  async execute() {
    return {
      error: 'Member skill discovery is not exposed by the current Bridges CLI.',
    };
  },
};

export const tools = [listMembers, memberSkills];

import { bridgesCli } from './shared.js';
import type { ToolDefinition } from './shared.js';

export const startDebate: ToolDefinition = {
  name: 'start_debate',
  description: 'Start a debate through the current Bridges CLI.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Debate topic or question' },
      projectId: { type: 'string', description: 'Project ID (proj_...)' },
      newSession: {
        type: 'boolean',
        description: 'Start a fresh debate session instead of continuing the active one',
      },
    },
    required: ['topic', 'projectId'],
  },
  async execute(params) {
    const args = [
      'debate',
      params.topic as string,
      '--project',
      params.projectId as string,
    ];
    if (params.newSession) args.push('--new-session');
    const output = await bridgesCli(args);
    return { success: true, output };
  },
};

export const vote: ToolDefinition = {
  name: 'vote',
  description: 'Legacy helper. Structured debate voting is not exposed by the current CLI.',
  parameters: {
    type: 'object',
    properties: {
      debateId: { type: 'string', description: 'Legacy debate identifier' },
      choice: { type: 'string', description: 'Chosen option' },
      projectId: { type: 'string', description: 'Project ID (proj_...)' },
    },
    required: ['debateId', 'choice', 'projectId'],
  },
  async execute() {
    return {
      error: 'Structured debate voting is not exposed by the current Bridges CLI.',
    };
  },
};

export const tools = [startDebate, vote];

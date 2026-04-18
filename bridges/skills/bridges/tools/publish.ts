import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bridgesCli } from './shared.js';
import type { ToolDefinition } from './shared.js';

export const publishArtifact: ToolDefinition = {
  name: 'publish_artifact',
  description: 'Publish an artifact through the current Bridges CLI.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the file to publish' },
      projectId: { type: 'string', description: 'Project ID (proj_...)' },
    },
    required: ['filePath', 'projectId'],
  },
  async execute(params) {
    const output = await bridgesCli([
      'publish',
      params.filePath as string,
      '--project',
      params.projectId as string,
    ]);
    return { success: true, output };
  },
};

export const listArtifacts: ToolDefinition = {
  name: 'list_artifacts',
  description: 'List all shared artifacts in the project.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const artifactsDir = join(dir, '.shared', 'artifacts');
    try {
      const files = await readdir(artifactsDir);
      return { artifacts: files };
    } catch {
      return { artifacts: [] };
    }
  },
};

export const tools = [publishArtifact, listArtifacts];

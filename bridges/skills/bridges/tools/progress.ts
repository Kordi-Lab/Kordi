import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadIdentity, readSharedFile } from './shared.js';
import type { ToolDefinition } from './shared.js';

export const updateProgress: ToolDefinition = {
  name: 'update_progress',
  description: 'Update your section in .shared/PROGRESS.md with current status.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'What you are currently working on' },
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
    required: ['status'],
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const sharedDir = join(dir, '.shared');
    await mkdir(sharedDir, { recursive: true });

    const identity = await loadIdentity();
    const progressPath = join(sharedDir, 'PROGRESS.md');
    const content = await readSharedFile('PROGRESS.md', dir);

    const timestamp = new Date().toISOString();
    const section = `### ${identity.nodeId} (${identity.owner})\n_Updated: ${timestamp}_\n\n${params.status}\n`;

    // Replace existing section or append
    const sectionRegex = new RegExp(
      `### ${identity.nodeId}[\\s\\S]*?(?=### |$)`
    );
    let updated: string;
    if (sectionRegex.test(content)) {
      updated = content.replace(sectionRegex, section + '\n');
    } else {
      const header = content ? '' : '# Progress\n\n';
      updated = header + content + section + '\n';
    }

    await writeFile(progressPath, updated, 'utf-8');
    return { success: true, nodeId: identity.nodeId, timestamp };
  },
};

export const getProgress: ToolDefinition = {
  name: 'get_progress',
  description: 'Read all agents\' progress from PROGRESS.md.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const content = await readSharedFile('PROGRESS.md', dir);
    if (!content) return { progress: [] };

    const sections = content.split(/(?=### )/).filter((s) => s.startsWith('### '));
    const progress = sections.map((s) => {
      const lines = s.split('\n');
      const header = lines[0].replace('### ', '');
      const body = lines.slice(1).join('\n').trim();
      return { agent: header, status: body };
    });

    return { progress };
  },
};

export const tools = [updateProgress, getProgress];

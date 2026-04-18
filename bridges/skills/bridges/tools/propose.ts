import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadIdentity,
  readSharedFile,
} from './shared.js';
import type { ToolDefinition } from './shared.js';

export const proposeAction: ToolDefinition = {
  name: 'propose_action',
  description: 'Record a proposal in .shared/PROPOSALS.md. Direct proposal delivery is not exposed by the current CLI.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Target agent node ID or label' },
      action: { type: 'string', description: 'Description of the proposed action' },
      details: { type: 'string', description: 'Additional details or context' },
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
    required: ['nodeId', 'action'],
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const identity = await loadIdentity();
    const proposalId = `P-${Date.now()}`;

    // Record locally
    const sharedDir = join(dir, '.shared');
    await mkdir(sharedDir, { recursive: true });
    const proposalsPath = join(sharedDir, 'PROPOSALS.md');
    const existing = await readSharedFile('PROPOSALS.md', dir);
    const header = existing ? '' : '# Proposals\n\n';
    const entry = `- **${proposalId}** [pending] ${params.action} → ${params.nodeId}${params.details ? `\n  Details: ${params.details}` : ''}\n`;
    await writeFile(proposalsPath, header + existing + entry, 'utf-8');

    return {
      success: true,
      proposalId,
      target: params.nodeId,
      recordedBy: identity.nodeId,
      note: 'Proposal recorded locally in .shared/PROPOSALS.md. Direct proposal delivery is not exposed by the current CLI.',
    };
  },
};

export const approve: ToolDefinition = {
  name: 'approve',
  description: 'Approve a pending proposal.',
  parameters: {
    type: 'object',
    properties: {
      proposalId: { type: 'string', description: 'Proposal ID (e.g. P-1234567890)' },
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
    required: ['proposalId'],
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const proposalsPath = join(dir, '.shared', 'PROPOSALS.md');
    const content = await readSharedFile('PROPOSALS.md', dir);
    if (!content) return { error: 'No proposals found.' };

    const pid = params.proposalId as string;
    const updated = content.replace(
      `**${pid}** [pending]`,
      `**${pid}** [approved]`
    );
    if (updated === content) {
      return { error: `Proposal ${pid} not found or already resolved.` };
    }

    await writeFile(proposalsPath, updated, 'utf-8');
    return { success: true, proposalId: pid, status: 'approved' };
  },
};

export const listProposals: ToolDefinition = {
  name: 'list_proposals',
  description: 'List all pending proposals.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const content = await readSharedFile('PROPOSALS.md', dir);
    if (!content) return { proposals: [] };

    const proposals = content
      .split('\n')
      .filter((line) => line.startsWith('- **P-'))
      .map((line) => {
        const match = line.match(/\*\*(P-\d+)\*\*\s+\[(\w+)\]\s+(.+?)(?:\s+→\s+(.+))?$/);
        return {
          id: match?.[1] ?? 'unknown',
          status: match?.[2] ?? 'unknown',
          action: match?.[3]?.trim() ?? line,
          target: match?.[4]?.trim() ?? '',
        };
      });

    return { proposals };
  },
};

export const tools = [proposeAction, approve, listProposals];

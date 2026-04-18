import { bridgesCli, loadIdentity } from './shared.js';
import type { ToolDefinition } from './shared.js';

export const initIdentity: ToolDefinition = {
  name: 'init_identity',
  description: 'Generate an Ed25519 keypair and Bridges node ID. Run once per machine.',
  parameters: {
    type: 'object',
    properties: {
      owner: {
        type: 'string',
        description: 'Human-readable owner name (e.g. "alice")',
      },
    },
    required: ['owner'],
  },
  async execute(params) {
    const owner = params.owner as string;
    const output = await bridgesCli(['init', '--owner', owner]);
    return { success: true, output };
  },
};

export const getIdentity: ToolDefinition = {
  name: 'get_identity',
  description: 'Show your node ID, owner, and runtime information.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    try {
      const identity = await loadIdentity();
      const status = await bridgesCli(['status']);
      return {
        nodeId: identity.nodeId,
        owner: identity.owner,
        status,
      };
    } catch {
      return { error: 'Identity not initialized. Run init_identity first.' };
    }
  },
};

export const tools = [initIdentity, getIdentity];

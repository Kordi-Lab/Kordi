// The Build screen's choices turned into the build request, kept free of React for tests.

import type { CgAgentFile, CgBuildRequest, CgDeviceItem } from './types';

export type CgBuildChoices = {
  memory: boolean;
  /** Connectors the account has connected. */
  connectedCount: number;
  useAgents: boolean;
  agentFiles: CgAgentFile[] | null;
  device: Array<{ source: string; items: CgDeviceItem[] }>;
  links: string;
  notes: string;
};

export function commonGroundBuildRequest(choices: CgBuildChoices): CgBuildRequest {
  const request: CgBuildRequest = {
    memory: choices.memory,
    connectors: choices.connectedCount > 0,
    device: choices.device,
    links: choices.links,
    notes: choices.notes,
  };
  if (choices.useAgents && choices.agentFiles?.length) request.agents = choices.agentFiles;
  return request;
}

export function canBuildProfile(choices: CgBuildChoices): boolean {
  const request = commonGroundBuildRequest(choices);
  return request.memory || request.connectors || Boolean(request.agents) || request.device.length > 0
    || request.links.trim().length > 0 || request.notes.trim().length > 0;
}

/** "AGENTS.md, CLAUDE.md +3", from the file names. */
export function agentFilesSummary(files: CgAgentFile[] | null): string {
  if (files === null) return 'Reading…';
  const names = files.map((file) => file.label.split('/').pop() ?? file.label);
  if (!names.length) return 'No agent files found';
  const head = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${head} +${names.length - 2}` : head;
}

// The Build screen's choices turned into the build request, kept free of React for tests.

import type { CgAgentFile, CgBuildRequest, CgDeviceItem, CgSourcePicks } from './types';

export type CgBuildChoices = {
  memory: boolean;
  /** Connected connectors whose switch is on. */
  connectors: string[];
  useAgents: boolean;
  agentFiles: CgAgentFile[] | null;
  device: Array<{ source: string; items: CgDeviceItem[] }>;
  links: string;
  notes: string;
  /** Kordi documents to read (`commonGroundVersion` 3). */
  documents?: string[];
  /** The picks to save with the build; set only with `commonGroundVersion` 3. */
  picks?: CgSourcePicks;
};

export const NO_PICKS: CgSourcePicks = { memory: false, connectors: [], device: [], agents: false, documents: [], links: '', notes: '' };

/** The picks a Build screen opens with: the saved ones, or none; Rebuild from memory turns Memory on. */
export function initialPicks(saved: CgSourcePicks | null | undefined, memory = false): CgSourcePicks {
  const picks = { ...NO_PICKS, ...saved };
  return memory ? { ...picks, memory: true } : picks;
}

export function commonGroundBuildRequest(choices: CgBuildChoices): CgBuildRequest {
  const request: CgBuildRequest = {
    memory: choices.memory,
    connectors: choices.connectors.length > 0,
    device: choices.device,
    links: choices.links,
    notes: choices.notes,
  };
  if (choices.useAgents && choices.agentFiles?.length) request.agents = choices.agentFiles;
  if (choices.picks) {
    request.connectorProviders = choices.connectors;
    request.documents = choices.documents ?? [];
    request.picks = choices.picks;
  }
  return request;
}

export function canBuildProfile(choices: CgBuildChoices): boolean {
  const request = commonGroundBuildRequest(choices);
  return request.memory || request.connectors || Boolean(request.agents) || request.device.length > 0
    || Boolean(choices.documents?.length) || request.links.trim().length > 0 || request.notes.trim().length > 0;
}

/** "AGENTS.md, CLAUDE.md +3", from the file names. */
export function agentFilesSummary(files: CgAgentFile[] | null): string {
  if (files === null) return 'Reading…';
  const names = files.map((file) => file.label.split('/').pop() ?? file.label);
  if (!names.length) return 'No agent files found';
  const head = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${head} +${names.length - 2}` : head;
}

/** "2 chosen", or "None chosen". */
export function documentsSummary(count: number): string {
  return count ? `${count} chosen` : 'None chosen';
}

/** A build that found nothing for the profile cannot succeed again with the same sources. */
export function buildFailureMessage(errorCode: string | null) {
  return errorCode === 'no_topics'
    ? 'Nothing here fits this profile. Add a note or choose other sources.'
    : 'Could not build your card. Try again.';
}

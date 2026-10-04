// Copy for "About this reply" (who wrote an agent reply and where it ran).
import type { ReplyDisclosure } from '@/features/cloud/agentTrustTypes';
import type { ReplyDisclosureTarget } from './replyDisclosureTarget';

export const REPLY_DISCLOSURE_FOOTNOTE = 'The model provider received this request and the messages the agent used. The provider\'s terms decide what it keeps. The AI label comes from the sender\'s Kordi app; Kordi checks which account sent the message.';

function possessive(name: string) {
  return `${name}'s`;
}

/** The rows "About this reply" shows for a reply the server described. */
export function replyDisclosureRows(disclosure: ReplyDisclosure, fallback: Pick<ReplyDisclosureTarget, 'agentName' | 'ownerName'> = { agentName: null, ownerName: null }): string[] {
  const agent = disclosure.agentName ?? fallback.agentName ?? 'Agent';
  const owner = disclosure.ownerName ?? fallback.ownerName ?? 'the owner';
  const kordiRuns = disclosure.credentials === 'kordi';
  const rows = [`Agent: ${agent}`, `Runs for: ${kordiRuns ? 'Kordi' : owner}`];
  if (disclosure.requesterName) rows.push(`Requested by: ${disclosure.requesterName}`);
  if (disclosure.runtime === 'owner_device') {
    rows.push(`Ran on: ${possessive(owner)} Mac`);
    rows.push(`Model: Chosen on ${possessive(owner)} Mac. Kordi isn't told which one.`);
    return rows;
  }
  if (disclosure.runtime === 'kordi_cloud') rows.push('Ran on: Kordi Cloud');
  const provider = disclosure.providerLabel ?? disclosure.provider;
  rows.push(disclosure.model && provider
    ? `Model: ${disclosure.model} (${provider})`
    : provider ? `Model: ${provider}` : disclosure.model ? `Model: ${disclosure.model}` : 'Model: Not reported');
  if (disclosure.credentials) rows.push(`Model account: ${kordiRuns ? 'Kordi\'s' : possessive(owner)}`);
  return rows;
}

export function pipDisclosureText(providerLabel: string | null | undefined): string {
  return providerLabel
    ? `PiP is Kordi's built-in plan helper. It runs on ${providerLabel} through Kordi's account.`
    : 'PiP is Kordi\'s built-in plan helper. It runs through Kordi\'s account.';
}

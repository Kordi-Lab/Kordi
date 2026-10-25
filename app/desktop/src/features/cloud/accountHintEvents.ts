/**
 * Account-private sync hints that ask this Mac to run something: a digest
 * run or a proactive run the server holds for this Mac, or a comment request
 * in a shared document. The server announces each held run only once, so a
 * hint the sync mapping drops leaves the run to the cloud once its hold ends.
 * `proactive.proposal_changed` tells the owner that one of their agents'
 * proactive offers was created or changed. `proactive.eval_requested` and
 * `proactive.run_requested` hold an evaluation or an allowed offer for this
 * Mac (`features/proactive/proactiveMacRuns`).
 */
export const ACCOUNT_HINT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'digest.run_requested',
  'document.agent_request',
  'proactive.eval_requested',
  'proactive.proposal_changed',
  'proactive.run_requested',
]);

/**
 * Account-private sync hints that ask this Mac to run something: a digest
 * run or a proactive run the server holds for this Mac, or a comment request
 * in a shared document. The server announces each held run only once, so a
 * hint the sync mapping drops leaves the run to the cloud once its hold ends.
 * `proactive.proposal_changed` tells the owner that one of their agents'
 * proactive offers was created or changed. `proactive.eval_requested` and
 * `proactive.run_requested` hold an evaluation or an allowed offer for this
 * Mac (`features/proactive/proactiveMacRuns`). `personal_agent.eval_requested`
 * holds a personal agent's evaluation of new connector events, which this Mac
 * runs like a proactive evaluation.
 * `common_ground.nearby.updated`
 * and `common_ground.nearby.alert` refresh open Grounding Nearby views
 * (`features/commonGround/nearbyHints`).
 */
export const ACCOUNT_HINT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'common_ground.nearby.alert',
  'common_ground.nearby.updated',
  'digest.run_requested',
  'document.agent_request',
  'personal_agent.eval_requested',
  'proactive.eval_requested',
  'proactive.proposal_changed',
  'proactive.run_requested',
]);

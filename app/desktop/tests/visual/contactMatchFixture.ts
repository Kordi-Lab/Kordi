// A fictional Grounding match, as `commonGround.match` on GET /v1/cloud/contacts/{id}/profile.
export const CONTACT_MATCH_VISUAL = {
  score: 82,
  headline: 'You both build memory for long-running agents.',
  shared: [
    { topic: 'Agent memory', theirTopic: 'Long-term memory', why: 'Both cards lead with it.' },
    { topic: 'Retrieval', theirTopic: 'Retrieval', why: 'Same topic.' },
    { topic: 'Memory evals', theirTopic: 'Eval design', why: 'Close focus.' },
  ],
  youBring: [{ topic: 'Grant writing', for: 'Lab funding', why: 'Listed under can help.' }],
  theyBring: [
    { topic: 'Eval datasets', for: 'Your benchmarks', why: 'Listed under can help.' },
    { topic: 'Vector stores', for: 'Your retrieval work', why: 'Close to what you are working on.' },
  ],
  nextStep: 'Compare notes on how you each evaluate recall.',
  yourProfile: { profileId: 'cgp_me', kind: 'work', name: 'Work', design: 'work', icon: null },
  theirProfile: { profileId: 'cgp_maya', kind: 'custom', name: 'Memory systems group', design: 'research', icon: 'flask' },
  updatedAt: '2026-10-21T08:00:00Z',
};

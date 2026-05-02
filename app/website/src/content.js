export const siteContent = {
  brand: {
    name: 'Kordi AI',
    email: 'hello@kordi.ai',
    tagline: 'AI agent infrastructure for Super Collaboration.',
  },
  nav: [
    { label: 'Mission', href: '#mission' },
    { label: 'System', href: '#system' },
    { label: 'Journal', href: '#journal' },
  ],
  hero: {
    title: 'AI agent infrastructure for Super Collaboration',
    description:
      'Kordi helps teams coordinate people, AI agents, shared context, and project memory in one collaboration system.',
    primaryAction: { label: 'Read our mission', href: '#mission' },
    secondaryAction: { label: 'Read the first note', href: '#journal' },
  },
  intro: {
    title: 'A collaboration layer for the agent era.',
    body:
      'Teams need a shared place where intent, execution, and memory stay connected across people and AI agents.',
    loops: [
      { label: 'Plan', body: 'Turn goals into shared direction.' },
      { label: 'Delegate', body: 'Coordinate work across agents and teammates.' },
      { label: 'Review', body: 'Keep changes traceable and decisions visible.' },
    ],
  },
  mission: {
    title: 'Our mission',
    body:
      'We are building the infrastructure layer for Super Collaboration: a way for teams to work with AI agents without losing context, ownership, or trust.',
    principles: [
      {
        title: 'Conversation as the interface',
        body:
          'Collaboration should feel natural. Kordi starts from the flow teams already understand: people talking, deciding, and moving work forward.',
        wash: 'cyan',
      },
      {
        title: 'Context that stays alive',
        body:
          'Agents become useful when they share memory with the team: goals, decisions, files, sessions, and the reasons behind the work.',
        wash: 'magenta',
      },
      {
        title: 'Execution with traceability',
        body:
          'Every handoff should be visible. The system should help teams understand what changed, who asked for it, and why it matters.',
        wash: 'yellow',
      },
    ],
  },
  system: {
    title: 'A system for building the system',
    body:
      'Kordi is shaped by our own workflow. We use agents, shared sessions, reviews, and team memory to build the collaboration infrastructure we need.',
    items: [
      {
        title: 'People',
        body: 'Intent, judgment, priorities, and review stay visible to the team.',
        wash: 'cyan',
      },
      {
        title: 'Agents',
        body: 'AI agents help plan, execute, research, and iterate across shared work.',
        wash: 'magenta',
      },
      {
        title: 'Memory',
        body: 'Project context persists so collaboration compounds instead of resetting.',
        wash: 'yellow',
      },
    ],
  },
  journal: {
    title: 'Journal',
    body: 'Notes from the work of designing, building, and using Kordi.',
    firstPost: {
      eyebrow: 'First note',
      title:
        'How did we build a supercollaboration system to help our team build the supercollaboration system?',
      summary:
        'A practical story about using our own infrastructure to coordinate people, agents, context, and decisions while building Kordi.',
      noteTitle: 'What it covers',
      note:
        'The loops, rituals, and agent workflows that helped us turn a small team into a more coordinated building system.',
    },
  },
};

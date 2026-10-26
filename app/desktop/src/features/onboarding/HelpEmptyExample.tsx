import { useHelpTourLocation } from './helpTourSession';

type Kind = 'contacts' | 'chat' | 'agents' | 'digest' | 'files' | 'memories';
const examples: Record<Kind, { targets: string[]; title: string; lines: string[] }> = {
  contacts: { targets: ['nav-contacts'], title: 'Alex · Example contact', lines: ['Product designer · Interested in accessible apps', 'Open a contact to see their profile and start a conversation.'] },
  chat: { targets: ['nav-chats'], title: 'Weekend plans · Example chat', lines: ['Alex: Shall we go for a hike on Saturday?', 'You: Yes! Let’s choose a trail.'] },
  agents: { targets: ['nav-agents'], title: 'Writing assistant · Example agent', lines: ['Instructions: Help me write clear, concise drafts.', 'Choose a connected model and the tools this agent may use.'] },
  digest: { targets: ['nav-digest'], title: 'Your day · Example overview', lines: ['10:00 · Review the app design', 'Next step · Send feedback on the navigation draft'] },
  files: { targets: ['settings-memory', 'memory-import-files', 'memory-import-run'], title: 'AGENTS.md · Example file', lines: ['Use TypeScript for app code.', 'Keep explanations short and include a concrete example.'] },
  memories: { targets: ['memory-review'], title: 'Example memories', lines: ['Prefers TypeScript for app projects.', 'Likes concise explanations with an example.'] },
};

/** Render only alongside an empty real list and only during its tour section. */
export function HelpEmptyExample({ kind }: { kind: Kind }) {
  const tour = useHelpTourLocation();
  const example = examples[kind];
  if (!tour || !example.targets.includes(tour.target)) return null;
  return <aside className="help-empty-example" data-help-demo={kind} aria-label={example.title}>
    <span className="help-example-badge">Example data · Only in this tour</span>
    <strong>{example.title}</strong>
    {example.lines.map((line) => <p key={line}>{line}</p>)}
  </aside>;
}

/** The Import section is otherwise absent when Memory is off or this device cannot import. */
export function HelpImportExample() {
  const tour = useHelpTourLocation();
  if (!tour || !examples.files.targets.includes(tour.target)) return null;
  return <section className="help-import-example">
    <div data-help-target="memory-import-files"><HelpEmptyExample kind="files" /></div>
    <button className="help-secondary" data-help-target="memory-import-run" disabled>Import example</button>
    <p>Example only. Enable Memory and choose your own files to import.</p>
  </section>;
}

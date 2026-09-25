import { createRoot } from 'react-dom/client';
import { MarkdownContent } from '../../src/kordi-app/components/markdown';
import { HumanMessageMarkdown } from '../../src/kordi-app/components/humanMessageMarkdown';
import '../../src/index.css';

const href = 'https://example.com/docs';
const cases = ['*', '**', '_', '__', '***', '___'].map((marker, index) => ({
  id: `emphasis-${index}`, label: marker, text: `${marker}[Documentation](${href})${marker}`,
}));
cases.push(
  { id: 'list', label: 'Nested list', text: `- Parent\n  - **[Documentation](${href})**` },
  { id: 'code', label: 'Literal code', text: `\`**[Documentation](${href})**\`` },
  { id: 'plain', label: 'Ordinary link', text: `[Documentation](${href})` },
);

createRoot(document.getElementById('root')!).render(
  <main className="kordi-app theme-dark" style={{ padding: 24, display: 'block', minHeight: '100vh' }}>
    <h1 style={{ marginBottom: 20 }}>Markdown emphasis links</h1>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
      {['agent', 'human', 'compact'].map(context => (
        <div key={context} data-context={context}>
          <h2 style={{ marginBottom: 16 }}>{context}</h2>
          {cases.filter(item => context !== 'compact' || item.id !== 'list').map(item => (
            <section key={item.id} data-case={item.id} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, opacity: 0.6 }}>{item.label}</div>
              {context === 'agent' ? <MarkdownContent text={item.text} /> : <HumanMessageMarkdown
                inline={context === 'compact'}
                message={{ role: 'user', sender: 'Tester', senderType: 'human', text: item.text, time: '12:00', statusChips: [] }}
              />}
            </section>
          ))}
        </div>
      ))}
    </div>
  </main>,
);

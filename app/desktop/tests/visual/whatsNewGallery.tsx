import { createRoot } from 'react-dom/client';

import { WhatsNewDialog } from '../../src/features/updates/WhatsNewDialog';

const theme = new URLSearchParams(window.location.search).get('theme') === 'light'
  ? 'light'
  : 'dark';

document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;

createRoot(document.querySelector('#root')!).render(
  <div className={`kordi-app theme-${theme} whats-new-visual-shell`}>
    <aside className="whats-new-visual-sidebar" aria-hidden="true">
      <div className="whats-new-visual-brand">kordi</div>
      <div className="whats-new-visual-avatar" />
      <div className="whats-new-visual-nav whats-new-visual-nav-active" />
      <div className="whats-new-visual-nav" />
      <div className="whats-new-visual-nav" />
    </aside>
    <section className="whats-new-visual-workspace" aria-hidden="true">
      <header><span>Messages</span><i /><i /></header>
      <div className="whats-new-visual-content">
        <div /><div /><div /><div />
      </div>
    </section>
    <WhatsNewDialog
      release={{
        version: '0.0.1-beta.12',
        notes: [
          '### What changed',
          '',
          '- Packaged Cloud builds keep Google and GitHub sign-in available when capability discovery is unavailable.',
          '- Group agents can mention conversation participants and their Kordi agents while preserving relevant reply history.',
        ].join('\n'),
        publishedAt: '2026-08-06T00:00:00Z',
        changelogUrl: 'https://kordi.ai/changelog#v0-0-1-beta-12',
      }}
      onDismiss={() => undefined}
      onOpenFullReleaseNotes={() => undefined}
    />
  </div>,
);

document.body.dataset.visualReady = 'true';

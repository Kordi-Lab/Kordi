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
          '### Added',
          '',
          '- Enabled group agents to mention conversation participants and their Kordi agents while preserving relevant reply history.',
          '',
          '### Fixed',
          '',
          '- Kept Google and GitHub sign-in available in packaged Cloud builds.',
          '- Improved identity consistency across profile and conversation surfaces.',
        ].join('\n'),
        publishedAt: '2026-08-08T00:00:00Z',
        changelogUrl: 'https://github.com/Kordi-Lab/Kordi/releases/tag/V0.0.1.beta12',
      }}
      onDismiss={() => undefined}
      onOpenFullReleaseNotes={() => undefined}
    />
  </div>,
);

document.body.dataset.visualReady = 'true';

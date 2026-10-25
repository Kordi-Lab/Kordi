import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import HelpMenu from '../../src/features/onboarding/HelpMenu';
import type { HelpAction } from '../../src/features/onboarding/helpContent';
import { HelpWorkspacePreview } from './helpWorkspacePreview';
import { HelpWelcome } from '../../src/features/onboarding/HelpWelcome';

const theme = new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark';
document.body.classList.add(`theme-${theme}`);
document.documentElement.style.colorScheme = theme;

function Fixture() {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<HelpAction | null>(null);
  return <div className={`kordi-app theme-${theme}`} style={{ minHeight: '100dvh', padding: 24, background: 'var(--app-page-bg)' }}>
    <button onClick={() => setOpen(true)} aria-label="Help & setup">?</button>
    <p data-testid="destination">{JSON.stringify(action)}</p>
    <textarea aria-label="Message draft" defaultValue="Keep this draft" />
    {open ? <HelpMenu anchor={{ left: 24, top: 24, width: 32, height: 32 }} progressKey="help-test-user" settingsAvailable supportAvailable onAction={setAction} onOpenSession={() => {}} onStartTour={() => {}} onDismiss={() => setOpen(false)} /> : null}
  </div>;
}
function WelcomeFixture() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [dismissed, setDismissed] = useState(false);
  return <div className={`kordi-app theme-${theme} app-cloud-workspace-surface`} inert style={{ width: 52, height: '100dvh', overflow: 'hidden', position: 'relative' }}>
    <button ref={trigger} style={{ position: 'absolute', bottom: 32, left: 12 }}>?</button>
    {!dismissed ? <HelpWelcome trigger={trigger} onStart={() => setDismissed(true)} onDismiss={() => setDismissed(true)} /> : null}
  </div>;
}
createRoot(document.querySelector('#root')!).render(new URLSearchParams(location.search).has('welcome') ? <WelcomeFixture /> : new URLSearchParams(location.search).has('isolated') ? <Fixture /> : <HelpWorkspacePreview theme={theme} />);

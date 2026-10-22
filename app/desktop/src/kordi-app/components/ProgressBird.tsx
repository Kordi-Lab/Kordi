/** Decorative activity indicator; the adjacent status supplies the accessible text. */
export function ProgressBird() {
  return <svg className="app-turn-progress-bird" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M4 15 2 18l6-1c5 2 9-1 10-5l4-1-4-1a3 3 0 0 0-5 0l-3 3-6 2Z" />
    <path className="app-turn-progress-bird-wing" d="M13 14C9 12 6 8 6 3c5 2 8 5 9 9" />
    <circle cx="16.5" cy="10.5" r=".6" fill="currentColor" stroke="none" />
  </svg>;
}

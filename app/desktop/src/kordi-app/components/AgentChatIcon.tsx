export function AgentChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3h10q5 0 5 5v7q0 5-5 5h-7q-3 2-5 3v-4q-3-1-3-4V8q0-5 5-5z" />
      <ellipse cx="9.2" cy="10.5" rx="1.1" ry="1.4" fill="currentColor" stroke="none" />
      <ellipse cx="17.2" cy="10.5" rx="1.1" ry="1.4" fill="currentColor" stroke="none" />
      <path d="M10 15q3 3 6 0" />
    </svg>
  );
}

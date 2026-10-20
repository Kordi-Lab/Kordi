/** Two people hugging: the Common ground mark. Matches the iOS asset. */
export function CommonGroundHugIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7.6" cy="10" r="2.6" />
      <circle cx="16.4" cy="10" r="2.6" />
      <path d="M2.6 21.2c0-3.6 2.3-5.9 5.2-5.9 1.7 0 3 .6 4.2 1.8 1.2-1.2 2.5-1.8 4.2-1.8 2.9 0 5.2 2.3 5.2 5.9" />
      <path d="M7.6 18.6c1.2 1.1 2.7 1.7 4.4 1.7s3.2-.6 4.4-1.7" />
    </svg>
  );
}

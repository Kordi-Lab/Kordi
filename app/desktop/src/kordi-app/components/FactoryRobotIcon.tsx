export function FactoryRobotIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="7" width="16" height="14" rx="4" />
      <path d="M12 7V3H9M1 12v5M23 12v5M8 12v2M16 12v2M9 17h6" />
    </svg>
  );
}

export function AgentWaitingWave({ label }: { label: string }) {
  return (
    <span className="app-agent-waiting-wave" role="status" aria-label={label}>
      <span className="app-agent-waiting-wave-bar" aria-hidden="true" />
      <span className="app-agent-waiting-wave-bar" aria-hidden="true" />
      <span className="app-agent-waiting-wave-bar" aria-hidden="true" />
    </span>
  );
}

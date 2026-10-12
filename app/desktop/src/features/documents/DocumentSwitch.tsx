export function DocumentSwitch({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="app-document-switch"
      onClick={() => onChange(!checked)}
    />
  );
}

// The labeled text field of the in-app login and sign-up form.

// Shared with CloudLoginPage, which reads its colors and type scale from the
// same theme tokens (theme-tokens.css).
export const TYPE_HINT = 'text-[12px] font-medium tracking-[-0.005em]';
export const INK = 'text-foreground';
export const INK_MUTED = 'text-muted-foreground';
const TYPE_LABEL = 'text-[12px] font-medium tracking-[-0.005em]';
const TYPE_INPUT = 'text-[15px] font-medium tracking-[-0.005em]';
const PAPER_INPUT = 'bg-[var(--app-cloud-login-input-bg)]';
const BORDER_SOFT = 'border-[var(--app-cloud-login-border)]';
const FOCUS_RING = 'focus:border-[var(--app-cloud-login-focus-border)] focus:shadow-[0_0_0_3px_var(--app-cloud-login-focus-ring)]';
const INPUT_BASE_CLASS = [
  'app-cloud-login-input h-12 rounded-full border px-5 outline-none transition',
  'focus:bg-[var(--app-cloud-login-input-focus-bg)]',
].join(' ');
const INPUT_ERROR_CLASS = [
  'border-[var(--app-cloud-login-danger-border)]',
  'focus:border-[var(--app-cloud-login-danger-border-strong)]',
  'focus:shadow-[0_0_0_3px_var(--app-cloud-login-danger-ring)]',
].join(' ');
const INPUT_HINT_CLASS = [
  'focus:border-[var(--app-cloud-login-hint-border)]',
  'focus:shadow-[0_0_0_3px_var(--app-cloud-login-hint-ring)]',
].join(' ');

type CloudFieldValidation = 'invalid' | 'hint' | undefined;

export function CloudField({
  label,
  ariaLabel,
  type,
  autoComplete,
  placeholder,
  value,
  onChange,
  validation,
  hint,
  disabled,
  inputMode,
  maxLength,
}: {
  label?: string;
  ariaLabel?: string;
  type: string;
  autoComplete: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
  validation?: CloudFieldValidation;
  hint?: string;
  disabled?: boolean;
  inputMode?: 'numeric';
  maxLength?: number;
}) {
  const baseInput = `${INPUT_BASE_CLASS} ${PAPER_INPUT} ${TYPE_INPUT} ${INK}`;
  const tone =
    validation === 'invalid'
      ? INPUT_ERROR_CLASS
      : validation === 'hint'
      ? `${BORDER_SOFT} ${INPUT_HINT_CLASS}`
      : `${BORDER_SOFT} ${FOCUS_RING}`;
  return (
    <label className={`grid gap-1.5 ${TYPE_LABEL} ${INK_MUTED}`}>
      {label ? <span>{label}</span> : null}
      <input
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label={ariaLabel ?? label}
        aria-invalid={validation === 'invalid' || undefined}
        disabled={disabled}
        inputMode={inputMode}
        maxLength={maxLength}
        className={`${baseInput} ${tone}`}
      />
      {hint ? (
        <span
          className={`${TYPE_HINT} normal-case tracking-normal ${
            validation === 'invalid'
              ? 'text-[var(--app-cloud-login-danger-text)]'
              : 'text-[var(--app-cloud-login-hint-text)]'
          }`}
        >
          {hint}
        </span>
      ) : null}
    </label>
  );
}

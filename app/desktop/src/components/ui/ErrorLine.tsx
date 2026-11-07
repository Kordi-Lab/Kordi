import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type ErrorLineAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

type ErrorLineProps = {
  children: ReactNode;
  /** Optional follow-up, such as "Try again" or "Sign in". */
  action?: ErrorLineAction | null;
  align?: 'start' | 'end' | 'center';
  id?: string;
  className?: string;
  /** `alert` announces the failure; use `status` for a standing condition. */
  role?: 'alert' | 'status';
};

/**
 * The one inline error form: a single short line in the error color under
 * what failed. Blocking decisions use AppDialog instead.
 */
export function ErrorLine({
  children,
  action = null,
  align = 'start',
  id,
  className,
  role = 'alert',
}: ErrorLineProps) {
  return (
    <p
      id={id}
      className={cn('app-error-line', className)}
      data-align={align === 'start' ? undefined : align}
      role={role}
    >
      <span>{children}</span>
      {action ? (
        <>
          <span className="app-error-line-separator" aria-hidden="true">·</span>
          <button
            type="button"
            className="app-error-line-action"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        </>
      ) : null}
    </p>
  );
}

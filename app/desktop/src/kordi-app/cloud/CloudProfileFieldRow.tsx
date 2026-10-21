import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** One row of the profile table: a fixed label column and a borderless value. */
export function CloudProfileFieldRow({ label, htmlFor, error, errorId, invalid, top, below, children }: {
  label: string;
  htmlFor?: string;
  /** One line under the value in the error colour. */
  error?: string;
  errorId?: string;
  invalid?: boolean;
  /** Aligns the label with the first line of a multi-line value. */
  top?: boolean;
  /** Extra content under the value, such as a status line or an inline form. */
  below?: ReactNode;
  children: ReactNode;
}) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className={cn('app-settings-row app-cloud-profile-row', top && 'app-cloud-profile-row-top')} data-invalid={invalid || undefined}>
      <Label htmlFor={htmlFor} className="app-cloud-profile-row-label text-[13px] font-medium leading-5 text-white">{label}</Label>
      <div className="min-w-0">
        <div className="app-cloud-profile-row-value">{children}</div>
        {error ? <div id={errorId} className="app-error-text app-cloud-profile-row-error" role="alert">{error}</div> : null}
        {below}
      </div>
    </div>
  );
}

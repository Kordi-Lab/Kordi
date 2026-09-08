import type { SVGProps } from 'react';

export function LivePhotoIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="10" strokeDasharray="1 2" />
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="3.5" />
  </svg>;
}

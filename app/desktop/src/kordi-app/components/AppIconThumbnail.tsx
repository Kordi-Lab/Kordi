import { useId } from 'react';

import type { AppIcon } from '@/app/appIconPreference';

const INK = '#1f1a17';
const AMBER = '#f7b32b';

/** The app icon drawn in place: background, then the bird with its eye and wing cut through. */
export function AppIconThumbnail({ icon, className }: { icon: AppIcon; className?: string }) {
  const id = useId();
  const cut = `${id}-cut`;
  const frost = `${id}-frost`;
  const bird = 'bird' in icon ? icon.bird : INK;
  const beak = 'beak' in icon ? icon.beak : AMBER;
  return (
    <svg className={className} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <defs>
        <mask id={cut} maskUnits="userSpaceOnUse" x="-100" y="-100" width="712" height="712">
          <ellipse cx="262" cy="292" rx="150" ry="136" fill="#fff" />
          <path d="M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z" fill="#fff" stroke="#fff" strokeWidth="4" strokeLinejoin="round" />
          <circle cx="194" cy="266" r="17" />
          <path d="M269.6,333.2 C292,299.6 348,282 397.6,285.2 C381.6,325.2 336.8,357.2 288.8,355.6 C272.8,354 264.8,344.4 269.6,333.2Z" />
        </mask>
        {'frosted' in icon ? <filter id={frost}><feGaussianBlur stdDeviation="70" /></filter> : null}
      </defs>
      <rect width="512" height="512" fill={icon.bg} />
      {'frosted' in icon ? (
        <>
          <g filter={`url(#${frost})`}>
            <circle cx="110" cy="120" r="120" fill="#ffb38a" />
            <circle cx="420" cy="150" r="120" fill="#8fd3ff" />
            <circle cx="300" cy="440" r="130" fill="#c6a8ff" />
          </g>
          <rect width="512" height="512" fill="#fff" opacity="0.55" />
        </>
      ) : null}
      <g transform="translate(256,250) scale(0.94) translate(-270,-292)">
        <path d="M120,276 L82,294 L120,312Z" fill={beak} stroke={beak} strokeWidth="12" strokeLinejoin="round" />
        <rect x="-100" y="-100" width="712" height="712" fill={bird} mask={`url(#${cut})`} />
      </g>
    </svg>
  );
}

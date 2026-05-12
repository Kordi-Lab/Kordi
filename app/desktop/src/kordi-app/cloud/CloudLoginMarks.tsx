const GOOGLE_PATHS = [
  {
    fill: '#FFC107',
    d: [
      'M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8',
      '-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039',
      'l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24',
      's8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z',
    ].join(''),
  },
  {
    fill: '#FF3D00',
    d: [
      'm6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12',
      'c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4',
      '16.318 4 9.656 8.337 6.306 14.691z',
    ].join(''),
  },
  {
    fill: '#4CAF50',
    d: [
      'M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36',
      'c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z',
    ].join(''),
  },
  {
    fill: '#1976D2',
    d: [
      'M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571',
      'l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z',
    ].join(''),
  },
] as const;

const GITHUB_PATH = [
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59',
  '.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94',
  '-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82',
  '.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95',
  '0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82',
  '.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82',
  '.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15',
  '0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48',
  '0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8',
  'c0-4.42-3.58-8-8-8z',
].join(' ');

const PAINT_CIRCLE_CLASS = [
  'absolute h-[62.9326%] w-[59.5238%] rounded-full opacity-[0.93]',
  'mix-blend-multiply shadow-[inset_0_3px_8px_rgba(255,255,255,0.16)]',
].join(' ');
const PAINT_ACCENTS = [
  {
    position: 'left-[20.2381%] top-0',
    fill: 'bg-[radial-gradient(circle_at_34%_24%,rgba(255,255,255,0.18),transparent_30%),oklch(0.66_0.26_355)]',
  },
  {
    position: 'left-0 top-[37.0673%]',
    fill: 'bg-[radial-gradient(circle_at_30%_24%,rgba(255,255,255,0.16),transparent_31%),oklch(0.72_0.16_211)]',
  },
  {
    position: 'left-[40.4762%] top-[37.0673%]',
    fill: 'bg-[radial-gradient(circle_at_32%_24%,rgba(255,255,255,0.18),transparent_30%),oklch(0.82_0.16_83)]',
  },
] as const;

export function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" className="h-[22px] w-[22px]">
      {GOOGLE_PATHS.map((path) => <path key={path.fill} fill={path.fill} d={path.d} />)}
    </svg>
  );
}

export function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" className="h-[22px] w-[22px]">
      <path d={GITHUB_PATH} />
    </svg>
  );
}

export function KordiPaintMark() {
  return (
    <span
      aria-hidden="true"
      className="kordi-paint-mark relative inline-block h-[42px] w-[71px] shrink-0 drop-shadow-[0_10px_18px_rgba(65,47,24,0.10)]"
    >
      {PAINT_ACCENTS.map((accent) => (
        <span key={accent.position} className={`${PAINT_CIRCLE_CLASS} ${accent.position} ${accent.fill}`} />
      ))}
    </span>
  );
}

const GOOGLE_PATHS = [
  {
    fill: '#4285F4',
    d: 'M17.64 9.20455c0-.63818-.05727-1.25273-.16364-1.84364H9v3.48182h4.84364c-.20864 1.125-.84364 2.07818-1.79591 2.71636v2.25818h2.90864C16.65818 14.25091 17.64 11.94545 17.64 9.20455z',
  },
  {
    fill: '#34A853',
    d: 'M9 18c2.43 0 4.46727-.80591 5.95636-2.18273l-2.90864-2.25818c-.80591.54-1.83727.85909-3.04773.85909-2.34409 0-4.32818-1.58318-5.03591-3.71045H.95727v2.33182C2.43818 15.98318 5.48182 18 9 18z',
  },
  {
    fill: '#FBBC05',
    d: 'M3.96409 10.70773c-.18-.54-.28227-1.11727-.28227-1.70773s.10227-1.16773.28227-1.70773V4.96045H.95727C.34773 6.17545 0 7.55045 0 9s.34773 2.82455.95727 4.03955l3.00682-2.33182z',
  },
  {
    fill: '#EA4335',
    d: 'M9 3.58182c1.32136 0 2.50773.45409 3.44045 1.34591l2.58136-2.58136C13.46318.89182 11.42591 0 9 0 5.48182 0 2.43818 2.01682.95727 4.96045l3.00682 2.33182C4.67182 5.165 6.65591 3.58182 9 3.58182z',
  },
] as const;

const GITHUB_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z';

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
    <svg
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
      shapeRendering="geometricPrecision"
      className="h-[18px] w-[18px] overflow-visible"
    >
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

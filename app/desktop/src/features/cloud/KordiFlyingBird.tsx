// The Kordi bird in flight. Geometry matches scripts/kordi-app-icons/icons.mjs;
// the wing is a separate piece outlined in the background color so it reads
// above the body while it flaps (see `.app-kordi-flying-bird` in the auth gate CSS).
export function KordiFlyingBird({ className }: { className?: string }) {
  return (
    <svg className={`app-kordi-flying-bird ${className ?? ''}`.trim()} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <g transform="translate(256,250) scale(0.94) translate(-270,-292)">
        <g className="app-kordi-flying-bird-body">
          <path className="app-kordi-flying-bird-beak" d="M120,276 L82,294 L120,312Z" strokeWidth="12" strokeLinejoin="round" />
          <path
            className="app-kordi-flying-bird-fill"
            fillRule="evenodd"
            d="M112,292 A150,136 0 1,0 412,292 A150,136 0 1,0 112,292Z M177,266 A17,17 0 1,0 211,266 A17,17 0 1,0 177,266Z"
          />
          <path
            className="app-kordi-flying-bird-fill"
            d="M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z"
            strokeWidth="4"
            strokeLinejoin="round"
          />
          <g transform="translate(296,262)">
            <path
              className="app-kordi-flying-bird-wing"
              d="M0,0 C40,-34 120,-36 165,0 C120,30 40,30 0,0Z"
              strokeWidth="14"
              strokeLinejoin="round"
            />
          </g>
        </g>
      </g>
    </svg>
  );
}

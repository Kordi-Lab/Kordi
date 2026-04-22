import 'react';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}

export {};

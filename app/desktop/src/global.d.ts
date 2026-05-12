import 'react';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __KORDI_BOOTSTRAP__?: {
      edition?: string;
      title?: string;
    };
  }
}

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}

export {};

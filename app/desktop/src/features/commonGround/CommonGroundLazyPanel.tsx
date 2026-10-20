import { lazy, Suspense } from 'react';

import type { CgHost } from './host';

const CommonGroundPanel = lazy(() => import('./CommonGroundPanel'));

/** Loads the Common ground page the first time its row is opened. */
export function CommonGroundLazyPanel({ host }: { host: CgHost }) {
  return <Suspense fallback={null}><CommonGroundPanel host={host} /></Suspense>;
}

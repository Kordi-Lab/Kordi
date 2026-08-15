import type { ReactNode } from 'react';

import { CloudCallContext } from './cloudCallContextValue';
import type { CloudCallsController } from './cloudCallController';

export function CloudCallProvider({
  controller,
  children,
}: {
  controller: CloudCallsController;
  children: ReactNode;
}) {
  return (
    <CloudCallContext.Provider value={controller}>
      {children}
    </CloudCallContext.Provider>
  );
}

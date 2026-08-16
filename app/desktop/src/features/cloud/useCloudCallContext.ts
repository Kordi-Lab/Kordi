import { useContext } from 'react';

import { CloudCallContext } from './cloudCallContextValue';
import type { CloudCallsController } from './cloudCallController';

export function useCloudCallContext(): CloudCallsController | null {
  return useContext(CloudCallContext);
}

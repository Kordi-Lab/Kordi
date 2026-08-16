import { createContext } from 'react';

import type { CloudCallsController } from './cloudCallController';

export const CloudCallContext = createContext<CloudCallsController | null>(null);

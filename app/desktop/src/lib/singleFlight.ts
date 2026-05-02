export type SingleFlightOperation = () => void | Promise<void>;

export interface SingleFlightState {
  running: boolean;
  pendingOperation: SingleFlightOperation | null;
  currentPromise: Promise<void> | null;
}

export function createSingleFlightState(): SingleFlightState {
  return {
    running: false,
    pendingOperation: null,
    currentPromise: null,
  };
}

export function requestSingleFlightRun(
  state: SingleFlightState,
  operation: SingleFlightOperation,
): Promise<void> | null {
  if (state.running) {
    state.pendingOperation = operation;
    return null;
  }

  state.running = true;

  const run = (async () => {
    let currentOperation: SingleFlightOperation | null = operation;

    try {
      while (currentOperation) {
        await currentOperation();
        currentOperation = state.pendingOperation;
        state.pendingOperation = null;
      }
    } finally {
      state.running = false;
      state.pendingOperation = null;
      state.currentPromise = null;
    }
  })();

  state.currentPromise = run;
  return run;
}

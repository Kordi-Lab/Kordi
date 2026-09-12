import assert from 'node:assert/strict';
import { act } from 'react';

export async function waitForReactCondition(condition: () => boolean, message: string) {
  const deadline = performance.now() + 5_000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, message);
    await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
  }
}

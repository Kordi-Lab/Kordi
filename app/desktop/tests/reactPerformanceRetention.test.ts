import assert from 'node:assert/strict';
import test from 'node:test';
import { installReactPerformanceRetention } from '../src/features/performance/reactPerformanceRetention';

test('React timing retention clears framework records, preserves app records, and disconnects', () => {
  let callback!: PerformanceObserverCallback;
  let disconnected = 0;
  const cleared: string[] = [];
  class Observer {
    constructor(next: PerformanceObserverCallback) { callback = next; }
    observe(options: PerformanceObserverInit) { assert.deepEqual(options, { type: 'measure', buffered: true }); }
    disconnect() { disconnected += 1; }
  }
  const stop = installReactPerformanceRetention({
    timeline: { clearMeasures: name => { cleared.push(name!); } },
    Observer: Observer as unknown as typeof PerformanceObserver,
  });
  const entry = (name: string, devtools: unknown) => ({ name, entryType: 'measure', detail: { devtools } });
  callback({ getEntries: () => [
    { name: '\u200bLargeProps', entryType: 'measure', get detail() { assert.fail('do not materialize serialized component props'); } },
    entry('Component', { track: 'Components ⚛' }),
    entry('Component', { track: 'Components ⚛' }),
    entry('Update', { trackGroup: 'Scheduler ⚛' }),
    entry('kordi:transcript-virtual-render', { track: 'Application' }),
  ] } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver);
  assert.deepEqual(cleared, ['\u200bLargeProps', 'Component', 'Update']);
  stop(); assert.equal(disconnected, 1);
  installReactPerformanceRetention({ retainHistory: true, Observer: class { constructor() { assert.fail('profiling opt-in must preserve timing history'); } } as unknown as typeof PerformanceObserver });
});

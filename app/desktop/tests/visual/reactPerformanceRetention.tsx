import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { installReactPerformanceRetention } from '../../src/features/performance/reactPerformanceRetention';

const root = createRoot(document.getElementById('root')!);
const enabled = new URLSearchParams(location.search).has('bounded');
function Payload({ payload }: { payload: { label: string; text: string } }) {
  return <span>{payload.label}</span>;
}
async function run() {
  // First emit a backlog, then verify that buffered observation also releases it.
  for (let index = 0; index < 240; index += 1) {
    if (enabled && index === 30) installReactPerformanceRetention();
    flushSync(() => root.render(<Payload payload={{ label: `Synthetic ${index}`, text: `${index}:` + 'Synthetic payload '.repeat(4000) }} />));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  performance.measure('kordi:synthetic-probe', { start: performance.now(), detail: { rowCount: 240 } });
  await new Promise(resolve => setTimeout(resolve, 50));
  document.body.dataset.complete = 'true';
}
void run();

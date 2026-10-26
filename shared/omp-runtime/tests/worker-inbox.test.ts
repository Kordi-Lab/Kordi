import { expect, test } from 'bun:test';
import { installDeferredWorkerInbox } from '../src/workerInbox';

function fixture() {
  let receive!: (message: unknown) => void;
  const inbox = installDeferredWorkerInbox({ on(_event, listener) { receive = listener; } });
  return { inbox, send: (message: unknown) => receive(message) };
}

test('early and subsequent messages wait for construction and retain their order', async () => {
  const { inbox, send } = fixture();
  const received: unknown[] = [];
  let constructed = false;
  send('init');
  inbox.bind(message => {
    expect(constructed).toBe(true);
    received.push(message);
  });
  send('close');
  expect(received).toEqual([]);
  constructed = true;
  await Promise.resolve();
  expect(received).toEqual(['init', 'close']);
});

test('closing a worker drops pending delivery to its detached handler', async () => {
  const { inbox, send } = fixture();
  const received: unknown[] = [];
  send('close');
  const unbind = inbox.bind(message => { received.push(message); unbind(); });
  send('late message');
  await Promise.resolve();
  expect(received).toEqual(['close']);
});

import { installWorkerInbox } from '@oh-my-pi/pi-utils/worker-host';

/** Buffer early messages without re-entering an OMP worker's constructor. */
export function installDeferredWorkerInbox(port: Parameters<typeof installWorkerInbox>[0]) {
  const inbox = installWorkerInbox(port);
  const bind = inbox.bind.bind(inbox);
  inbox.bind = handler => {
    let active = true;
    // OMP 18.12.6 replays buffered messages synchronously inside bind(). A
    // queued close can therefore run before the worker assigns its unsubscribe
    // and rejection-guard callbacks. Defer all delivery to preserve FIFO order
    // while allowing construction to finish, including in source-mode workers.
    const unbind = bind(message => {
      queueMicrotask(() => {
        if (active) handler(message);
      });
    });
    return () => {
      active = false;
      unbind();
    };
  };
  return inbox;
}

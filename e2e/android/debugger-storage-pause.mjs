// EX02: suspend this renderer's JavaScript using an ACTUAL debugger event.
// A pause ACK is insufficient on an idle page. A side-effect-free evaluation
// triggers the requested pause; keep its promise until resume/target teardown.
// Discard all event payloads (call frames can contain private application data).
export function createDebuggerStoragePause(session) {
  let enabled = false;
  let paused = false;
  let attempted = false;
  let disposed = false;
  let triggerSettled = Promise.resolve(true);
  let resolvePause;
  const pauseReady = new Promise(resolve => { resolvePause = resolve; });
  const onPaused = () => { paused = true; resolvePause(true); };
  const onResumed = () => { paused = false; };
  session.on('Debugger.paused', onPaused);
  session.on('Debugger.resumed', onResumed);

  return {
    isPaused: () => paused && !disposed,
    async pause({ step }) {
      if (attempted || disposed) throw new Error('pause control already used');
      attempted = true;
      await step('debugger-domain', () => session.send('Debugger.enable'));
      enabled = true;
      await step('pause-request', () => session.send('Debugger.pause'));
      // Do not await this evaluation while paused: it settles after resume.
      // No application expression, storage access or variable value is used.
      triggerSettled = session.send('Runtime.evaluate', {
        expression: 'void 0', returnByValue: true,
      }).then(() => true, () => false);
      const observed = await step('pause-event', () => pauseReady);
      return { method: 'debugger-pause', eventObserved: observed === true && paused && !disposed };
    },
    async release({ step }, targetClosed = false) {
      if (disposed) return;
      try {
        if (enabled && !targetClosed) {
          if (paused) await step('resume', () => session.send('Debugger.resume'));
          // Also cancels a pending pause request when no event was observed.
          await step('debugger-disable', () => session.send('Debugger.disable'));
        }
        const settled = await step('pause-trigger-settled', () => triggerSettled);
        if (!settled && !targetClosed) throw new Error('pause trigger unavailable');
      } finally {
        disposed = true;
        paused = false;
        resolvePause(false);
        session.off('Debugger.paused', onPaused);
        session.off('Debugger.resumed', onResumed);
      }
    },
  };
}

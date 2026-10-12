const FRAME_BUDGET = 10; // ms
const CHUNK_SIZE = 100;

export default function factory({window} = {}) {
  let scheduled = false;
  let frameId = 0;
  let queue = [];

  // Resolved lazily: the default dodo instance is built at import time, which
  // in Node or a jsdom/happy-dom test may run before any animation frame or
  // performance API exists on the global object.
  function host() {
    return window ?? globalThis;
  }

  function requestFrame(f) {
    const raf = host().requestAnimationFrame;
    // ~1 frame at 60Hz. setTimeout also keeps the queue draining in
    // environments with no rAF at all, such as SSR and background workers.
    return typeof raf === 'function' ? raf.call(host(), f) : setTimeout(f, 16);
  }

  function cancelFrame(id) {
    const caf = host().cancelAnimationFrame;
    if (typeof caf === 'function') {
      caf.call(host(), id);
    } else {
      clearTimeout(id);
    }
  }

  function now() {
    return host().performance?.now() ?? Date.now();
  }

  function _runTasks(tasks) {
    for (const f of tasks) {
      try {
        f();
      } catch (err) {
        console.error('Error in scheduled function:', err);
      }
    }
  }

  function runQueue() {
    const startTime = now();
    frameId = 0;

    while (queue.length > 0) {
      const chunk = queue.splice(0, CHUNK_SIZE);
      _runTasks(chunk);

      if (now() - startTime > FRAME_BUDGET && queue.length > 0) {
        frameId = requestFrame(runQueue);
        return;
      }
    }

    scheduled = false;
  }

  // Schedules a function to be executed on the next animation frame.
  function schedule(f, {signal} = {}) {
    if (signal?.aborted) {
      return;
    }

    let task = f;
    // If a signal is provided, wrap the task to check for abortion before execution.
    if (signal) {
      task = () => {
        if (!signal.aborted) {
          f();
        }
      };
    }

    queue.push(task);

    if (!scheduled) {
      scheduled = true;
      frameId = requestFrame(runQueue);
    }
  }

  // Immediately runs all queued tasks synchronously.
  function flush() {
    if (frameId) {
      cancelFrame(frameId);
      frameId = 0;
    }
    // Tasks commonly schedule more work (a reconcile that queues a follow-up
    // render). Draining in a loop means flush() leaves an empty queue rather
    // than an orphaned one that no frame is pending for.
    scheduled = true;
    while (queue.length > 0) {
      const toRun = queue;
      queue = [];
      _runTasks(toRun);
    }
    scheduled = false;
  }

  // Clears all pending tasks.
  function clear() {
    if (frameId) {
      cancelFrame(frameId);
    }
    queue = [];
    scheduled = false;
    frameId = 0;
  }

  return {schedule, flush, clear};
}

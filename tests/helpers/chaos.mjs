// Deterministic contention and fault injection for engine-level tests.
//
// Everything here is seeded. A failing seeded test names its seed; rerun it
// with CHAOS_SEED=<seed> to replay exactly that schedule and fault plan.
//
//   createRandom(seed)            -> { seed, next(), int(n), pick(list), shuffle(list), chance(p) }
//                                    Small PRNG (mulberry32). Never use Math.random in chaos tests.
//   forEachSeed(count, fn, {base}) -> runs `await fn(random)` once per seed, sequentially.
//                                    Seeds are base, base+1, ...; base defaults to CHAOS_SEED or 1.
//                                    A failure is rethrown with "seed=N" in its message.
//   createScheduler(random)       -> { wrap(object, label), run(tasks), trace }
//                                    Deterministic interleaving. `wrap` returns a proxy whose
//                                    method calls park at a gate. `run([() => promise, ...])`
//                                    starts every task and repeatedly waits until each live task
//                                    is parked (or finished), then releases one parked call chosen
//                                    by `random`. It resolves with Promise.allSettled-style results.
//                                    Only calls made inside `run` tasks are gated (AsyncLocalStorage),
//                                    so set-up code can use the same wrapped object directly.
//                                    `trace` lists released calls as "task#i label.method".
//   injectFaults(object, rules, {random}) -> proxy with `.calls` (log of {method, n, fault})
//                                    rule: { method, when, mode = 'throw', error }
//                                      when: n (1-based nth call of method) | [n, ...] | 'always'
//                                            | probability in (0,1) drawn from `random`
//                                            | (call) => boolean, call = { method, n, args }
//                                      mode: 'throw'     reject before the real call runs
//                                            'after'     run the real call, then reject (partial commit:
//                                                        the effect happened, the caller sees a failure)
//                                            'duplicate' run the real call twice, return the second result
//                                                        (at-least-once delivery)
//                                            'timeout'   reject with { code: 'timeout' } without running
//                                    Rules are matched in order; the first match wins.
//   fakeClock(start)              -> { now(), advance(ms), set(ms) }; pass `clock.now` as a `clock`.
//   concurrently(fns)             -> starts each `fn` on its own macrotask (as independent requests
//                                    would arrive) and resolves with Promise.allSettled-style results.
//   tally(results, ok)            -> counts settled outcomes by value or fault code: {accepted: 3, quota_exceeded: 2}.
import { AsyncLocalStorage } from 'node:async_hooks';

export {createRandom,fakeClock} from '../../packages/app/memory-providers.mjs';
import {createRandom} from '../../packages/app/memory-providers.mjs';
export async function forEachSeed(count, fn, { base = Number(process.env.CHAOS_SEED ?? 1) } = {}) {
  for (let seed = base; seed < base + count; seed++) {
    try { await fn(createRandom(seed)); }
    catch (error) {
      if (error && typeof error === 'object') {
        // Reporters print the stack, which captured the old message; patch both.
        const original = String(error.message ?? ''), stack = error.stack; error.message = `seed=${seed} (rerun with CHAOS_SEED=${seed}): ${original}`;
        if (typeof stack === 'string') error.stack = original && stack.includes(original) ? stack.replace(original, error.message) : `${error.message}\n${stack}`;
        throw error;
      }
      throw new Error(`seed=${seed} (rerun with CHAOS_SEED=${seed}): ${String(error)}`);
    }
  }
}

const turn = () => new Promise(resolve => setImmediate(resolve));

export function createScheduler(random, { stallMs = 5000 } = {}) {
  const storage = new AsyncLocalStorage();
  const parked = [];
  const trace = [];
  let tasks = null;
  let seq = 0;
  const gate = (label, method, call) => {
    const task = storage.getStore();
    if (task === undefined || !tasks) return call();
    return new Promise((resolve, reject) => {
      parked.push({ task, seq: seq++, name: `task#${task} ${label}.${method}`, release: () => Promise.resolve().then(call).then(resolve, reject) });
    });
  };
  const wrap = (object, label = 'resource') => new Proxy(object, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function' || typeof key === 'symbol') return value;
      return (...args) => gate(label, key, () => value.apply(target, args));
    },
  });
  async function run(work) {
    if (tasks) throw new Error('Scheduler is already running');
    tasks = work.map(() => ({ done: false }));
    const results = work.map((fn, index) => storage.run(index, () => Promise.resolve().then(fn)).then(
      value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }),
    ).finally(() => { tasks[index].done = true; }));
    try {
      for (;;) {
        const deadline = Date.now() + stallMs;
        // Quiescent: every live task has at least one parked call.
        for (;;) {
          await turn();
          const live = tasks.map((t, i) => (t.done ? -1 : i)).filter(i => i >= 0);
          if (!live.length) return await Promise.all(results);
          const waiting = new Set(parked.map(p => p.task));
          if (live.every(i => waiting.has(i))) break;
          if (Date.now() > deadline) throw new Error(`Scheduler stalled; tasks ${live.filter(i => !waiting.has(i)).join(',')} neither parked nor finished`);
        }
        // Arrival order can vary with thread-pool crypto; choose from a stable order.
        // Within a task, park order follows program order, so (task, seq) is stable.
        parked.sort((a, b) => a.task - b.task || a.seq - b.seq);
        const [chosen] = parked.splice(random.int(parked.length), 1);
        trace.push(chosen.name);
        chosen.release();
      }
    } finally { tasks = null; }
  }
  return { wrap, run, trace };
}

const matches = (rule, call, random) => {
  const { when = 'always' } = rule;
  if (when === 'always') return true;
  if (typeof when === 'function') return Boolean(when(call));
  if (Array.isArray(when)) return when.includes(call.n);
  if (Number.isInteger(when)) return when === call.n;
  if (typeof when === 'number' && when > 0 && when < 1) { if (!random) throw new TypeError('Probability rules need a seeded random'); return random.chance(when); }
  throw new TypeError('Invalid fault rule');
};

export function injectFaults(object, rules, { random } = {}) {
  const counts = new Map();
  const calls = [];
  return new Proxy(object, {
    get(target, key, receiver) {
      if (key === 'calls') return calls;
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function' || typeof key === 'symbol') return value;
      return async (...args) => {
        const n = (counts.get(key) ?? 0) + 1; counts.set(key, n);
        const call = { method: key, n, args };
        const rule = rules.find(r => r.method === key && matches(r, call, random));
        calls.push({ method: key, n, fault: rule?.mode ?? (rule ? 'throw' : null) });
        const failure = () => rule.error ?? Object.assign(new Error(`Injected ${rule.mode ?? 'throw'} fault in ${String(key)} call ${n}`), { code: 'injected_fault' });
        if (!rule) return value.apply(target, args);
        switch (rule.mode ?? 'throw') {
          case 'throw': throw failure();
          case 'timeout': throw rule.error ?? Object.assign(new Error(`Injected timeout in ${String(key)} call ${n}`), { code: 'timeout' });
          case 'after': await value.apply(target, args); throw failure();
          case 'duplicate': await value.apply(target, args); return value.apply(target, args);
          default: throw new TypeError(`Unknown fault mode ${rule.mode}`);
        }
      };
    },
  });
}

export const concurrently = fns => Promise.all(fns.map(fn => new Promise(resolve => setTimeout(resolve)).then(fn).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))));
export const tally = (results, ok = () => 'fulfilled') => results.reduce((counts, r) => {
  const name = r.status === 'fulfilled' ? ok(r.value) : r.reason?.code ?? String(r.reason);
  counts[name] = (counts[name] ?? 0) + 1; return counts;
}, {});

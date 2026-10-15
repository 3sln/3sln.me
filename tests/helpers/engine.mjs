// Engine-level harness: domain services run as ngin Actions over injected
// resources. Each resource (store, service, clock, fake provider) is a
// singleton Provider; an operation sees only what it leases, never the engine.
// Every dispatch starts on its own macrotask, so concurrent operations
// interleave at their awaits exactly as independent requests would.
//
//   const e = domainEngine({ store, delivery });
//   await e.run(({ delivery }) => delivery.deliver(credential, input));
//   await e.all([...]);   // Promise.allSettled-style results
//   await e.dispose();
import { Engine, Provider, Action } from '../../vendor/ngin/index.js';

class ResultEvent extends Event { constructor(value) { super('result'); this.value = value; } }

export class Operation extends Action {
  constructor(deps, run) { super(); this.deps = deps; this.run = run; }
  async execute(resources, { dispatchFeed, signal }) { dispatchFeed.dispatchEvent(new ResultEvent(await this.run(resources, { signal }))); }
}

export function domainEngine(resources) {
  const names = Object.keys(resources);
  const engine = new Engine({ providers: Object.fromEntries(names.map(name => [name, Provider.fromSingleton(resources[name])])) });
  const run = async (fn, deps = names) => (await engine.dispatch(new Operation(deps, fn)).next('result')).value;
  const all = fns => Promise.all(fns.map(fn => run(fn).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))));
  return { engine, run, all, dispose: () => engine.dispose() };
}

// Counts settled outcomes by value or fault code: {accepted: 3, quota_exceeded: 2}.
export const tally = (results, ok = () => 'fulfilled') => results.reduce((counts, r) => {
  const name = r.status === 'fulfilled' ? ok(r.value) : r.reason?.code ?? String(r.reason);
  counts[name] = (counts[name] ?? 0) + 1; return counts;
}, {});

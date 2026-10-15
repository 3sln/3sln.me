import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandom, createScheduler, injectFaults, forEachSeed, fakeClock } from './helpers/chaos.mjs';

// A deliberately racy read-modify-write store: the scheduler must be able to
// expose its lost update, and must replay the same schedule for the same seed.
class Counter { value = 0; async read() { return this.value; } async write(value) { this.value = value; } }
async function racyRun(seed) {
  const scheduler = createScheduler(createRandom(seed)), store = scheduler.wrap(new Counter(), 'counter');
  const increment = async () => { const value = await store.read(); await store.write(value + 1); };
  await scheduler.run([increment, increment, increment]);
  return { value: await store.read(), trace: scheduler.trace };
}

test('chaos scheduler: same seed replays the same interleaving and some seed exposes a lost update', async () => {
  const first = await racyRun(7), again = await racyRun(7);
  assert.deepEqual(again, first);
  const outcomes = new Set();
  for (let seed = 1; seed <= 20; seed++) outcomes.add((await racyRun(seed)).value);
  assert(outcomes.has(3), 'some schedule is serial');
  assert([...outcomes].some(value => value < 3), 'some schedule loses an update');
});

test('chaos faults: nth, after (partial commit), duplicate and timeout modes are observable', async () => {
  const target = new Counter();
  const faulty = injectFaults(target, [
    { method: 'write', when: 1, mode: 'after' },
    { method: 'write', when: 2, mode: 'duplicate' },
    { method: 'write', when: 3, mode: 'timeout' },
    { method: 'read', when: call => call.n === 2 },
  ]);
  await assert.rejects(faulty.write(5), { code: 'injected_fault' });
  assert.equal(target.value, 5, 'after-mode commits before failing');
  await faulty.write(6); assert.equal(target.value, 6);
  await assert.rejects(faulty.write(7), { code: 'timeout' }); assert.equal(target.value, 6);
  assert.equal(await faulty.read(), 6); await assert.rejects(faulty.read(), { code: 'injected_fault' });
  assert.deepEqual(faulty.calls.map(c => c.fault), ['after', 'duplicate', 'timeout', null, 'throw']);
});

test('chaos seeds: failures name a reproducible seed; random streams are deterministic', async () => {
  assert.deepEqual(Array.from({ length: 5 }, createRandom(3).next), Array.from({ length: 5 }, createRandom(3).next));
  await assert.rejects(forEachSeed(3, async random => { if (random.seed === 2) throw new Error('boom'); }, { base: 1 }), /seed=2 .*CHAOS_SEED=2.*boom/);
  const clock = fakeClock(10); clock.advance(5); assert.equal(clock.now(), 15); clock.set(1); assert.equal(clock.now(), 1);
});

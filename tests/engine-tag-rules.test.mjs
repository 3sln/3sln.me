// Engine-level tag rules and labels: the production Tags Actions and Queries
// dispatched through the application engine (tests/helpers/app-engine.mjs).
// Promotion semantics of the rules engine itself stay in engine-tags.test.mjs
// (service level). Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEngine, ownerActor, OTHER } from './helpers/app-engine.mjs';
import { createScheduler, forEachSeed } from './helpers/chaos.mjs';
import { TagRules, ReplaceRules, DeleteRule, RestoreDefaultRule, TagLabels, SetTagLabel } from '../packages/app/domains/tags.mjs';
import { TAG_CATEGORIES } from '../packages/messaging/tags.mjs';

const BASE = Number(process.env.CHAOS_SEED ?? 1), actor = ownerActor();
const custom = (id, tag = 'work') => ({ id, enabled: true, match: { tagsAll: [tag] }, actions: { addTags: ['reviewed'] } });

test('defaults are seeded on first read; replacing re-stamps server-owned markers and revisions', async t => {
  const e = await createTestEngine(); t.after(() => e.dispose());
  const seeded = await e.read(new TagRules({ actor }));
  assert.equal(seeded.length, TAG_CATEGORIES.length); assert.ok(seeded.every(rule => rule.default && rule.revision === 1));
  const forged = seeded.map(rule => rule.id === 'default:promote.spam' ? { ...rule, default: { version: 99, base: 'forged' }, revision: 40 } : rule);
  const saved = await e.perform(new ReplaceRules({ actor, input: { rules: [...forged, custom('mine')] } }));
  const spam = saved.find(rule => rule.id === 'default:promote.spam');
  assert.notEqual(spam.default.base, 'forged'); assert.equal(spam.revision, 1); assert.equal(saved.at(-1).revision, 1);
  await assert.rejects(e.perform(new ReplaceRules({ actor, input: { rules: [{ id: 'default:mine', enabled: true, match: { tagsAll: ['x'] }, actions: {} }] } })), { code: 'invalid_rules' });
  // A replace with no list is refused (the former route answered it as a read).
  await assert.rejects(e.perform(new ReplaceRules({ actor, input: {} })), { code: 'invalid_rules' });
  assert.equal((await e.read(new TagRules({ actor: ownerActor(OTHER) }))).some(rule => rule.id === 'mine'), false, 'rules are per owner');
});

test('deleting and restoring a default rule; an unknown default cannot be restored', async t => {
  const e = await createTestEngine(); t.after(() => e.dispose());
  await e.read(new TagRules({ actor }));
  const remaining = await e.perform(new DeleteRule({ actor, id: 'default:promote.social' }));
  assert.equal(remaining.some(rule => rule.id === 'default:promote.social'), false);
  assert.deepEqual(await e.read(new TagRules({ actor })), remaining, 'a deleted default is never re-seeded');
  assert.deepEqual(await e.perform(new DeleteRule({ actor, id: 'absent' })), remaining, 'deleting an absent rule changes nothing');
  const restored = await e.perform(new RestoreDefaultRule({ actor, id: 'default:promote.social' }));
  assert.equal(restored.revision, 1); assert.ok((await e.read(new TagRules({ actor }))).some(rule => rule.id === restored.id));
  await assert.rejects(e.perform(new RestoreDefaultRule({ actor, id: 'default:promote.unknown' })), { code: 'not_found' });
  assert.deepEqual(e.audit.entries.map(entry => `${entry.operation}:${entry.outcome}`), ['rules.delete:ok', 'rules.delete:ok', 'rules.restore-default:ok', 'rules.restore-default:error']);
});

test('concurrent rule deletions both persist under every seeded interleaving; read-then-replace would lose one', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  let lost = 0;
  await forEachSeed(12, async random => {
    const scheduler = createScheduler(random), e = await createTestEngine({ seed: random.seed, wrap: { accountStore: store => scheduler.wrap(store, 'accountStore') } });
    try {
      await e.perform(new ReplaceRules({ actor, input: { rules: [...await e.read(new TagRules({ actor })), custom('a', 'a'), custom('b', 'b')] } }));
      const results = await scheduler.run(['a', 'b'].map(id => () => e.perform(new DeleteRule({ actor, id }))));
      assert.ok(results.every(r => r.status === 'fulfilled'), scheduler.trace.join('\n'));
      assert.deepEqual((await e.read(new TagRules({ actor }))).filter(rule => ['a', 'b'].includes(rule.id)), [], scheduler.trace.join('\n'));
      // The former route shape (read the list, then replace it) as two separate operations.
      await e.perform(new ReplaceRules({ actor, input: { rules: [...await e.read(new TagRules({ actor })), custom('a', 'a'), custom('b', 'b')] } }));
      await scheduler.run(['a', 'b'].map(id => async () => { const rules = await e.read(new TagRules({ actor })); return e.perform(new ReplaceRules({ actor, input: { rules: rules.filter(rule => rule.id !== id) } })); }));
      if ((await e.read(new TagRules({ actor }))).some(rule => ['a', 'b'].includes(rule.id))) lost++;
    } finally { await e.dispose(); }
  });
  assert.ok(lost > 0, 'the seeded schedules reach the lost update the single-transaction DeleteRule prevents');
});

test('tag labels: strict input, revision conflicts and generated IDs from the seeded random provider', async t => {
  const e = await createTestEngine({ seed: 5 }); t.after(() => e.dispose());
  assert.deepEqual(await e.read(new TagLabels({ actor })), { revision: 0, labels: {} });
  const named = await e.perform(new SetTagLabel({ actor, input: { label: 'Clients', expectedRevision: 0 } }));
  assert.match(named.id, /^t\.[0-9a-f]{20}$/); assert.equal(named.revision, 1);
  const again = await createTestEngine({ seed: 5 }); t.after(() => again.dispose());
  assert.equal((await again.perform(new SetTagLabel({ actor, input: { label: 'Clients' } }))).id, named.id, 'same seed, same generated tag');
  await assert.rejects(e.perform(new SetTagLabel({ actor, input: { label: 'Stale', expectedRevision: 0 } })), { code: 'tag_label_conflict' });
  for (const input of [null, 'Clients', { label: 'x', owner: OTHER }, { id: 'sys:spam', label: 'Mine' }])
    await assert.rejects(e.perform(new SetTagLabel({ actor, input })), { code: 'invalid_tag_label' });
  await e.perform(new SetTagLabel({ actor, input: { id: named.id, label: null } }));
  assert.deepEqual(await e.read(new TagLabels({ actor })), { revision: 2, labels: {} });
  assert.deepEqual(e.events.map(event => event.type), ['tag-labels-changed', 'tag-labels-changed']);
});

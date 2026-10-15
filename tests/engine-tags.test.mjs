// Engine-level tag promotion: classifier/heuristic evidence, default and owner
// rules, owner overrides and suppression, asserted on the owner's message view.
// Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSuspectedTag, isSystemTag, MAX_USER_TAGS } from '../packages/messaging/tags.mjs';
import { forEachSeed } from './helpers/chaos.mjs';
import { messagingFixture, OWNER } from './helpers/messaging-fixture.mjs';

const BASE = Number(process.env.CHAOS_SEED ?? 1);
const classifier = (labels, version = 'c1') => ({ source: 'classifier', version, labels: labels.map(tag => ({ tag, probability: 0.9 })) });
const heuristic = labels => ({ source: 'heuristic', version: 'h1', labels: labels.map(tag => ({ tag })) });
async function one(options) {
  const f = await messagingFixture(options), { receipt } = await f.deliver(), id = receipt.payload.messageId;
  const view = async () => (await f.messages.list(OWNER)).find(m => m.id === id);
  return { ...f, id, view, auto: input => f.messages.applyAutomatedTags(OWNER, id, input), owner: actions => f.messages.update(OWNER, id, actions) };
}

test('classifier spam is promoted once, quarantines and withdraws the pending notification; replays change nothing', async () => {
  const f = await one();
  assert.equal((await f.state()).events, 1);
  const promoted = await f.auto(classifier(['sys:suspected.spam']));
  assert.ok(promoted.tags.includes('sys:spam')); assert.ok(!promoted.tags.includes('sys:suspected.spam'));
  assert.equal(promoted.quarantined, true); assert.equal(promoted.classification, 'spam');
  assert.equal((await f.state()).events, 0);
  // Same source again, a later classifier version, and heuristic evidence for the same tag: all no-ops on tags and quarantine.
  for (const input of [classifier(['sys:suspected.spam']), classifier(['sys:suspected.spam'], 'c2'), heuristic(['sys:suspected.spam'])]) {
    const again = await f.auto(input);
    assert.deepEqual(again.tags, promoted.tags); assert.equal(again.quarantined, true);
  }
  // Sender-controlled heuristics alone never finalize: they stay suspected.
  const g = await one(), hinted = await g.auto(heuristic(['sys:suspected.promotional']));
  assert.ok(hinted.tags.includes('sys:suspected.promotional')); assert.ok(!hinted.tags.includes('sys:promotional'));
});

test('owner overrides win: a released, untagged message is never re-tagged or re-quarantined by later automation', async () => {
  const f = await one();
  await f.messages.setRules(OWNER, [...await f.messages.rules(OWNER), { id: 'promo-quarantine', enabled: true, match: { tagsAll: ['sys:suspected.promotional'], source: 'classifier' }, actions: { quarantined: true } }]);
  await f.auto(classifier(['sys:suspected.spam']));
  const released = await f.owner({ removeTags: ['sys:spam'], quarantined: false });
  assert.equal(released.quarantined, false); assert.ok(!released.tags.includes('sys:spam'));
  assert.equal((await f.state()).events, 1, 'releasing an unread message re-queues its notification');
  const later = await f.auto(classifier(['sys:suspected.spam', 'sys:suspected.promotional'], 'c2'));
  assert.ok(!later.tags.includes('sys:spam'), 'suppressed final tag is not re-added');
  assert.ok(later.tags.includes('sys:promotional'), 'unrelated categories still promote');
  assert.equal(later.quarantined, false, 'automation never re-quarantines an owner-released message');
  // The owner may restore what they removed; only automation is suppressed.
  assert.ok((await f.owner({ addTags: ['sys:spam'] })).tags.includes('sys:spam'));
});

test('suppressing a suspected tag before promotion blocks its default rule even when new evidence arrives', async () => {
  const f = await one();
  await f.auto(heuristic(['sys:suspected.spam']));
  const cleared = await f.owner({ removeTags: ['sys:suspected.spam'] });
  assert.ok(!cleared.tags.includes('sys:suspected.spam'));
  const after = await f.auto(classifier(['sys:suspected.spam']));
  assert.ok(!after.tags.some(t => t === 'sys:spam' || t === 'sys:suspected.spam')); assert.equal(after.quarantined, false);
  // No owner path invents a suspected tag that automation has not suggested.
  await assert.rejects(f.owner({ addTags: ['sys:suspected.social'] }), { code: 'invalid_actions' });
});

test('owner rules fire at most once and never cascade from rule output', async () => {
  const f = await messagingFixture();
  await f.messages.setRules(OWNER, [
    { id: 'tag-it', enabled: true, match: { tagsAll: ['contact:developer'] }, actions: { addTags: ['triaged'] } },
    { id: 'cascade', enabled: true, match: { tagsAll: ['triaged'] }, actions: { quarantined: true } },
  ]);
  const { receipt } = await f.deliver(), id = receipt.payload.messageId, view = (await f.messages.list(OWNER)).find(m => m.id === id);
  assert.deepEqual(view.tags, ['contact:developer', 'triaged']); assert.equal(view.quarantined, false);
  // Automated evidence re-runs only rules newly matched by it.
  const again = await f.messages.applyAutomatedTags(OWNER, id, classifier(['sys:suspected.code']));
  assert.equal(again.tags.filter(t => t === 'triaged').length, 1);
});

test('user tag limit is exact for owners; an automated rule overflow skips only its tag changes', async () => {
  const f = await one({ intake: { autoTags: [], optionalTags: [] } });
  const tags = Array.from({ length: MAX_USER_TAGS }, (_, i) => `t${i}`);
  assert.equal((await f.owner({ tags })).tags.length, MAX_USER_TAGS);
  await assert.rejects(f.owner({ addTags: ['one-more'] }), { code: 'invalid_actions' });
  assert.equal((await f.view()).tags.length, MAX_USER_TAGS, 'refused update is atomic');
  await f.messages.setRules(OWNER, [...await f.messages.rules(OWNER), { id: 'overflow', enabled: true, match: { tagsAll: ['sys:suspected.recruitment'], source: 'classifier' }, actions: { addTags: ['recruiting'], quarantined: true } }]);
  const result = await f.auto(classifier(['sys:suspected.recruitment']));
  assert.ok(!result.tags.includes('recruiting')); assert.equal(result.quarantined, true);
  assert.ok(result.tagHistory.some(entry => entry.op === 'skip' && entry.ruleId === 'overflow'));
});

test('seeded owner/automation interleavings keep tag invariants and bounded history', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  const suspected = ['sys:suspected.spam', 'sys:suspected.promotional', 'sys:suspected.social', 'sys:suspected.code'];
  const user = ['a', 'b', 'c', 'd'];
  await forEachSeed(6, async random => {
    const f = await one();
    let released = false; const removedByOwner = new Set();
    for (let step = 0; step < 120; step++) {
      const before = await f.view();
      if (random.chance(0.4)) {
        const input = random.chance(0.5) ? classifier(random.shuffle(suspected).slice(0, 1 + random.int(2)), `c${random.int(3)}`) : heuristic(random.shuffle(suspected).slice(0, 1 + random.int(2)));
        const after = await f.auto(input);
        for (const tag of removedByOwner) assert.ok(!after.tags.includes(tag) || before.tags.includes(tag), `automation re-added owner-removed ${tag}`);
        if (released && !before.quarantined) assert.equal(after.quarantined, false, 'never re-quarantined after release');
      } else {
        const choice = random.int(4), present = before.tags;
        const actions = choice === 0 && present.length ? { removeTags: [random.pick(present)] }
          : choice === 1 ? { addTags: [random.pick(user)] }
          : choice === 2 ? { quarantined: random.chance(0.5) }
          : { read: random.chance(0.5) };
        let after; try { after = await f.owner(actions); } catch (error) { assert.equal(error.code, 'invalid_actions'); continue; }
        for (const tag of actions.removeTags ?? []) removedByOwner.add(tag);
        for (const tag of actions.addTags ?? []) removedByOwner.delete(tag);
        if (actions.quarantined === false) released = true;
        if (actions.quarantined === true) released = false;
      }
      const m = await f.view();
      assert.equal(new Set(m.tags).size, m.tags.length);
      assert.ok(m.tags.filter(tag => !isSystemTag(tag)).length <= MAX_USER_TAGS);
      for (const tag of m.tags.filter(isSuspectedTag)) assert.ok(m.automated?.[tag], `suspected ${tag} without evidence`);
      assert.ok((m.tagHistory ?? []).length <= 16 && (m.tagSuppressed ?? []).length <= 64 && (m.firedRules ?? []).length <= 100);
    }
  }, { base: BASE });
});

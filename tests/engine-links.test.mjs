// Engine-level link parsing, audience validity and replay-record invariants.
// Seeded: rerun a failure with CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLinkQuery, strictJSON as linkJSON } from '../packages/messaging/bindle-links.mjs';
import { strictJSON as deliveryJSON } from '../packages/messaging/contact-delivery.mjs';
import { MemoryMessagingStore, ContactTokenService, ContactEndpointService, MessagingService, signContactToken } from '../packages/messaging/index.mjs';
import { fromBase64url, strictText } from '../packages/messaging/store.mjs';
import { LinkReplayRecord } from '../packages/messaging/link-replay.mjs';
import { prepareLinkResponse, signLinkResponse, verifyLinkResponse } from '../packages/identity/link-response.mjs';
import { SqliteMetadata } from '../apps/node/resources.mjs';
import { createRandom, forEachSeed, injectFaults, fakeClock } from './helpers/chaos.mjs';
import { domainEngine, tally } from './helpers/engine.mjs';

const BASE = Number(process.env.CHAOS_SEED ?? 1);
const B64 = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'];
const b64 = (random, n) => Array.from({ length: n }, () => random.pick(B64)).join('');
const NAMES = ['bindle_meta', 'bindle_data', 'BINDLE_META', 'Bindle_data', '%62indle_meta', 'bindle%5Fmeta', 'bindle_Meta', 'sig', 'SIG', '%73ig', 'bindle_x', 'bindle_', 'bindle', 'x', 'a+b', 'bindle+meta', '', '%zz', '%', '%e2%82', 'é', 'bindle_meta ', ' bindle_meta'];
const value = random => random.pick([
  () => `${b64(random, 1 + random.int(40))}.${b64(random, 1 + random.int(40))}.${b64(random, 1 + random.int(86))}`,
  () => `${b64(random, 3)}.${b64(random, 3)}`, () => '', () => 'a.b.c.d', () => '%41.b.c', () => 'a.b.c=', () => 'a..c',
  () => `${b64(random, 5000)}.a.b`, () => `${b64(random, 2100)}.a.b`, () => 'a.b.c#frag',
])();
function randomTarget(random) {
  const parts = Array.from({ length: random.int(6) }, () => {
    const name = random.pick(NAMES); if (random.chance(0.1)) return name;
    return `${name}=${value(random)}`;
  });
  const query = parts.join(random.chance(0.9) ? '&' : '&&');
  return random.pick([`https://h.example/p?${query}`, `https://h.example/p?${query}#f`, `https://h.example/p#f?${query}`, `https://h.example/p?${query}#?bindle_meta=a.b.c`, `https://h.example/p`]);
}
const bindleish = name => name.toLowerCase().startsWith('bindle_');

test('raw-query parser: seeded fuzz agrees with WHATWG URLSearchParams on every accepted or ignored link', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  const seen = new Set();
  await forEachSeed(4, async random => {
    for (let i = 0; i < 500; i++) {
      const target = randomTarget(random); let result, error;
      try { result = parseLinkQuery(target); } catch (e) { error = e; }
      const params = [...new URL(target).searchParams];
      if (error) {
        // Only the one stable fault, and only when a bindle_ parameter (in any spelling) is present.
        assert.equal(error.code, 'link_malformed', target);
        assert.ok(params.some(([name]) => bindleish(name)) || target.length > 18000, `rejected without a bindle parameter: ${target}`);
        assert.throws(() => parseLinkQuery(target), { code: 'link_malformed' });
        seen.add('malformed'); continue;
      }
      assert.deepEqual(parseLinkQuery(target), result, 'deterministic');
      seen.add(result.form);
      if (result.form === 'none') assert.ok(!params.some(([name]) => bindleish(name) || name.toLowerCase() === 'sig'), target);
      if (result.form === 'legacy') { assert.ok(params.some(([name]) => name.toLowerCase() === 'sig'), target); assert.ok(!params.some(([name]) => bindleish(name)), target); }
      if (result.form === 'link') {
        // Exactly the canonical spellings, once each, and no other bindle_ parameter.
        const bindle = params.filter(([name]) => bindleish(name));
        assert.deepEqual(bindle.filter(([name]) => name === 'bindle_meta').map(([, v]) => v), [result.meta], target);
        assert.deepEqual(bindle.filter(([name]) => name === 'bindle_data').map(([, v]) => v), result.data === undefined ? [] : [result.data], target);
        assert.equal(bindle.length, result.data === undefined ? 1 : 2, target);
        assert.ok(!params.some(([name]) => name.toLowerCase() === 'sig'), target);
        // Re-serializing the parsed parts yields the same parse.
        assert.deepEqual(parseLinkQuery(`https://h.example/p?bindle_meta=${result.meta}${result.data === undefined ? '' : `&bindle_data=${result.data}`}`), result);
      }
    }
  }, { base: BASE });
  for (const form of ['none', 'legacy', 'link', 'malformed']) assert.ok(seen.has(form), `generator reached ${form}`);
});

test('raw-query parser: alternative encodings, duplicates, legacy mixing and size bounds fail closed', () => {
  const meta = `${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`;
  assert.deepEqual(parseLinkQuery(`https://h.example/?bindle_meta=${meta}`), { form: 'link', meta });
  for (const target of [`?%62indle_meta=${meta}`, `?bindle%5Fmeta=${meta}`, `?BINDLE_META=${meta}`, `?bindle_meta=${meta}&bindle_meta=${meta}`, `?bindle_meta=${meta}&sig=x`, `?bindle_data=${meta}`, `?bindle_meta=${meta}&bindle_other=1`, `?bindle_meta`, `?bindle_meta=${'a'.repeat(4097)}.b.c`, `?bindle_meta=${meta}&bindle_data=${'a'.repeat(2049)}.b.c`, `?bindle_meta=${meta}&pad=${'x'.repeat(8200)}`, 'x'.repeat(18001)])
    assert.throws(() => parseLinkQuery(target), { code: 'link_malformed' }, target);
  // Exact size limits are inclusive.
  const metaAt = `${'a'.repeat(4096 - 4)}.b.c`, dataAt = `${'a'.repeat(2048 - 4)}.b.c`;
  assert.equal(parseLinkQuery(`?bindle_meta=${metaAt}&bindle_data=${dataAt}`).meta, metaAt);
  assert.deepEqual(parseLinkQuery(`?sig=${'x'.repeat(17000)}`), { form: 'legacy' });
  assert.deepEqual(parseLinkQuery('#?bindle_meta=junk'), { form: 'none' });
  for (const bad of [null, 1, {}, undefined]) assert.throws(() => parseLinkQuery(bad), { code: 'link_malformed' });
});

// Mutated JSON: strict parsers may refuse more than JSON.parse, never accept something different.
function mutateJSON(random) {
  const leaf = () => random.pick([0, 1, -1, 1.5, 1e21, 2 ** 53, 'x', 'é', '😀', true, false, null, '__proto__']);
  const build = depth => depth > 3 || random.chance(0.3) ? leaf() : random.chance(0.5) ? Array.from({ length: random.int(4) }, () => build(depth + 1)) : Object.fromEntries(Array.from({ length: random.int(4) }, () => [random.pick(['a', 'b', '__proto__', 'é', '']), build(depth + 1)]));
  let text = JSON.stringify(build(0));
  for (let n = random.int(4); n > 0; n--) {
    const at = random.int(text.length + 1), piece = random.pick(['"', ',', '{', '}', '[', ']', ':', '\\', '\\u', '\\ud800', '0', '-', '.', 'e', ' ', '\u0000', '﻿', '"a":1,', 'tru']);
    text = random.chance(0.5) ? text.slice(0, at) + piece + text.slice(at) : text.slice(0, at) + text.slice(at + 1);
  }
  return text;
}
test('strict JSON parsers: seeded differential against JSON.parse, bounded depth, only typed faults', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  const outcomes = { accepted: 0, refused: 0 };
  await forEachSeed(4, async random => {
    for (let i = 0; i < 400; i++) {
      const text = mutateJSON(random);
      let reference; try { reference = { value: JSON.parse(text) }; } catch { reference = null; }
      for (const [parse, code] of [[linkJSON, 'invalid_json'], [deliveryJSON, 'invalid_envelope']]) {
        let parsed; try { parsed = { value: parse(text) }; } catch (error) { assert.ok([code, 'too_large'].includes(error.code), `${error.code} for ${JSON.stringify(text)}`); outcomes.refused++; continue; }
        outcomes.accepted++;
        assert.ok(reference, `strict parser accepted invalid JSON ${JSON.stringify(text)}`);
        assert.deepEqual(parsed.value, reference.value, JSON.stringify(text));
      }
    }
  }, { base: BASE });
  assert.ok(outcomes.accepted > 100 && outcomes.refused > 100, JSON.stringify(outcomes));
  for (const deep of ['['.repeat(10000), '{"a":'.repeat(10000), `${'['.repeat(18)}${']'.repeat(18)}`]) {
    assert.throws(() => linkJSON(deep), { code: 'invalid_json' });
    assert.throws(() => deliveryJSON(deep), { code: 'invalid_envelope' });
  }
});

// Conditional responses: every (iat, exp, now) the verifier accepts yields a
// replay row the bounded record accepts at that same instant.
const ORIGIN = 'https://3sln.example', BOB = '55555555-5555-4555-8555-555555555555', OWNER = '11111111-1111-4111-8111-111111111111';
async function responseFixture() {
  const clock = fakeClock(1800000000000), store = new MemoryMessagingStore(), tokens = new ContactTokenService({ store, issuer: ORIGIN, clock: clock.now });
  const ownerKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await tokens.registerKey(OWNER, { kid: 'one', alg: 'ES256', publicJwk: await crypto.subtle.exportKey('jwk', ownerKey.publicKey) });
  const endpoints = new ContactEndpointService({ tokens, signer: async () => ownerKey.privateKey });
  const messages = new MessagingService({ store, tokens: endpoints, clock: clock.now }), collection = await messages.createCollection(OWNER, 'Inbox');
  const issued = await endpoints.createLink(OWNER, { handle: 'alice', kid: 'one', collections: [collection.id], mimeTypes: ['text/plain'], expiresAt: clock.now() + 86400000, audience: {} });
  const bob = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), bobJwk = await crypto.subtle.exportKey('jwk', bob.publicKey);
  const account = { active: true, handle: 'bob', key: { kid: 'bob-key', alg: 'ES256', active: true, purpose: 'signing', publicJwk: { kty: 'EC', crv: 'P-256', x: bobJwk.x, y: bobJwk.y } } };
  const base = (await signLinkResponse({ meta: prepareLinkResponse(issued.url), principal: { iss: ORIGIN, sub: BOB, handle: 'bob@3sln.example' }, key: { kid: 'bob-key', privateKey: bob.privateKey }, clock: clock.now })).data;
  const inspected = await endpoints.inspect(`${issued.url}&bindle_data=${base}`, { allowData: true });
  const [h, p] = base.split('.'), header = JSON.parse(strictText(fromBase64url(h))), claims = JSON.parse(strictText(fromBase64url(p)));
  const resign = changes => signContactToken({ header, claims: { ...claims, ...changes }, privateKey: bob.privateKey });
  const verify = data => verifyLinkResponse({ meta: inspected.meta, data, origin: ORIGIN, resolve: async () => structuredClone(account), clock: clock.now });
  return { clock, inspected, claims, resign, verify };
}
test('audience validity boundaries compose with the replay record at every boundary instant', async () => {
  const f = await responseFixture(), t = f.claims.iat, metaIat = f.inspected.meta.claims.iat, metadata = new SqliteMetadata(':memory:');
  const replay = new LinkReplayRecord({ metadata, clock: f.clock.now });
  let accepted = 0, refused = 0, n = 0;
  try {
    // Boundaries in seconds; instants probe each edge to the millisecond.
    for (const [iat, exp] of [[t, t + 300], [t, t + 1], [t - 60, t + 240], [metaIat - 60, metaIat + 240], [t + 100, t + 400], [t, t + 301], [t, t], [metaIat - 61, metaIat + 200]]) {
      const data = await f.resign({ iat, exp });
      for (const instant of [iat - 60 - 0.001, iat - 60, iat, exp, exp + 60 - 0.001, exp + 60]) {
        f.clock.set(Math.round(instant * 1000));
        const valid = iat < exp && exp - iat <= 300 && iat >= metaIat - 60 && iat - 60 <= instant && instant < exp + 60;
        let checked; try { checked = await f.verify(data); } catch (error) { assert.equal(error.code, 'audience_stale'); assert.equal(valid, false, `verifier refused a valid response iat=${iat} exp=${exp} now=${instant}`); refused++; continue; }
        assert.equal(valid, true, `verifier accepted iat=${iat} exp=${exp} now=${instant}`);
        // A unique parent per probe: the same nonce would otherwise be single-use.
        await replay.consume({ parent: `p${n++}`, iss: checked.principal.iss, sub: checked.principal.sub, key: checked.replay.key, expiresAt: checked.replay.expiresAt });
        accepted++;
      }
    }
  } finally { metadata.close(); }
  assert.ok(accepted >= 15 && refused >= 15, `probed both sides (${accepted}/${refused})`);
});

const hash = i => String(i).padStart(43, 'A'), user = i => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;
test('replay record under a storm: exact principal and parent caps, single use, bounded rows, expiry reopens in purge batches', async () => {
  const clock = fakeClock(1800000000000), metadata = new SqliteMetadata(':memory:');
  const replay = new LinkReplayRecord({ metadata, clock: clock.now, principalCap: 3, parentCap: 420, evaluationRate: 1, purgeBatch: 64 });
  const e = domainEngine({ replay });
  const consume = (i, sub, ttl = 420000) => ({ replay }) => replay.consume({ parent: 'parent', iss: ORIGIN, sub, key: hash(i), expiresAt: clock.now() + ttl });
  try {
    // 50 concurrent copies of one response: exactly one is admitted.
    assert.deepEqual(tally(await e.all(Array.from({ length: 50 }, () => consume(0, user(0)))), () => 'consumed'), { consumed: 1, audience_stale: 49 });
    // 4 concurrent distinct responses from one principal: the live-row cap is exact.
    assert.deepEqual(tally(await e.all([1, 2, 3, 4].map(i => consume(i, user(0)))), () => 'consumed'), { consumed: 2, audience_unavailable: 2 });
    // 500 distinct principals: exactly the parent cap is admitted, never evicting a live row.
    const storm = tally(await e.all(Array.from({ length: 500 }, (_, i) => consume(1000 + i, user(1000 + i)))), () => 'consumed');
    assert.deepEqual(storm, { consumed: 420 - 3, audience_unavailable: 500 - 417 });
    const rows = async () => (await metadata.list({ prefix: 'link-replay/' })).size;
    assert.equal(await rows(), 3 * 420 + 1, 'three rows per live response plus one counter');
    await assert.rejects(e.run(consume(0, user(0))), { code: 'audience_stale' });
    // One millisecond early nothing has expired; at expiry each admission purges at most one batch.
    clock.advance(420000 - 1); await assert.rejects(e.run(consume(9999, user(9999))), { code: 'audience_unavailable' });
    clock.advance(1); assert.equal((await e.run(consume(9999, user(9999)))).consumed, true);
    assert.equal(await rows(), 3 * (420 - 64 + 1) + 1);
    assert.equal(await replay.purge('parent', 1000), 420 - 64);
    assert.equal(await rows(), 3 * 1 + 1);
  } finally { await e.dispose(); metadata.close(); }
});

test('replay record chaos: a commit whose acknowledgement is lost never admits the response twice', async t => {
  t.diagnostic(`CHAOS_SEED base ${BASE}`);
  await forEachSeed(6, async random => {
    const clock = fakeClock(1800000000000), metadata = new SqliteMetadata(':memory:');
    const faulty = injectFaults(metadata, [{ method: 'transaction', when: 0.3, mode: random.pick(['after', 'throw', 'timeout']) }], { random });
    const replay = new LinkReplayRecord({ metadata: faulty, clock: clock.now });
    let admitted = 0;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        try { await replay.consume({ parent: 'p', iss: ORIGIN, sub: BOB, key: hash(7), expiresAt: clock.now() + 1000 }); admitted++; }
        catch (error) { assert.ok(['injected_fault', 'timeout', 'audience_stale'].includes(error.code), error.code); }
      }
      // The durable record holds at most one row set, and once committed every retry is stale.
      assert.ok(admitted <= 1);
      const live = (await metadata.list({ prefix: 'link-replay/p/h/' })).size;
      assert.ok(live <= 1);
      if (live) await assert.rejects(new LinkReplayRecord({ metadata, clock: clock.now }).consume({ parent: 'p', iss: ORIGIN, sub: BOB, key: hash(7), expiresAt: clock.now() + 1000 }), { code: 'audience_stale' });
      else assert.equal(admitted, 0);
    } finally { metadata.close(); }
  }, { base: BASE });
});

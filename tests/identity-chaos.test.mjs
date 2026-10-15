import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandom, createScheduler, injectFaults, forEachSeed, fakeClock } from './helpers/chaos.mjs';
import { identityEngine, activate, signupInput, sessionContext, context, memoryShards, MemoryAccounts, MemoryDevices, PASSWORD } from './helpers/identity-engine.mjs';

// Engine-level contention and fault injection for identity. Every schedule and
// fault plan derives from a logged seed; rerun a failure with CHAOS_SEED=<seed>.
const settledCodes = results => results.filter(r => r.status === 'rejected').map(r => r.reason?.code ?? r.reason?.message);

test('chaos: concurrent logins, logout and rename on one account never lose a committed session', async () => {
  await forEachSeed(25, async random => {
    const scheduler = createScheduler(random), base = new MemoryAccounts();
    const { act, service } = identityEngine({ repository: scheduler.wrap(base, 'accounts') });
    const { ownerContext, owner } = await activate(act), sessionId = (await service.owner({}, ownerContext)).sessionContext;
    const work = [
      ...Array.from({ length: 4 }, () => () => act('loginPassword', signupInput())),
      () => act('logout', {}, ownerContext),
      () => act('renameSession', { sessionId, label: 'Renamed laptop' }, ownerContext),
    ];
    const results = await scheduler.run(work);
    const loggedOut = results[4].status === 'fulfilled';
    // Optimistic conflicts are the only failure, except that a rename racing a committed logout finds its session gone.
    assert.deepEqual([...new Set(settledCodes(results))].filter(code => code !== 'conflict' && !(code === 'unauthorized' && loggedOut && results[5].status === 'rejected')), [], `trace ${scheduler.trace.join(' | ')}`);
    const stored = await base.get(owner.account.id), logins = results.slice(0, 4).filter(r => r.status === 'fulfilled');
    for (const { value } of logins) assert.equal((await service.owner({}, sessionContext(value))).account.id, owner.account.id, 'a fulfilled login is durable');
    if (loggedOut) await assert.rejects(service.owner({}, ownerContext), { code: 'unauthorized' });
    assert.equal(stored.sessions.length, logins.length + (loggedOut ? 0 : 1), 'no phantom or lost sessions');
    if (results[5].status === 'fulfilled' && !loggedOut) assert.equal(stored.sessions.find(s => s.id === sessionId).label, 'Renamed laptop');
  });
});

test('chaos: device handoff racing cancellation authorizes at most once and a confirmed cancel leaves no live device session', async () => {
  await forEachSeed(30, async random => {
    const clock = fakeClock(), scheduler = createScheduler(random), accounts = new MemoryAccounts(), devices = new MemoryDevices();
    const { act, service } = identityEngine({ repository: scheduler.wrap(accounts, 'accounts'), deviceRequests: scheduler.wrap(devices, 'devices'), clock });
    const { ownerContext, owner } = await activate(act), device = { ...context, deviceBinding: 'tv' };
    const request = await act('createDeviceLogin', { label: 'TV', turnstileToken: 'verified' }, device);
    await act('approveDeviceLogin', { requestId: request.requestId, userCode: request.userCode, accountHandle: owner.account.handle, approved: true }, ownerContext);
    clock.advance(6000);
    const results = await scheduler.run([() => act('pollDeviceLogin', request, device), () => act('pollDeviceLogin', request, device), () => act('cancelDeviceLogin', request, device)]);
    const authorized = results.slice(0, 2).filter(r => r.status === 'fulfilled' && r.value.status === 'authorized').map(r => r.value);
    assert(authorized.length <= 1, `two device handoffs; trace ${scheduler.trace.join(' | ')}`);
    const cancelled = results[2].status === 'fulfilled' && results[2].value.cancelled === true;
    for (const value of authorized) {
      if (cancelled) await assert.rejects(service.owner({}, sessionContext(value)), { code: 'unauthorized' }, 'cancel confirmed but device session lives');
      else assert.equal((await service.owner({}, sessionContext(value))).account.id, owner.account.id);
    }
    const stored = await accounts.get(owner.account.id);
    assert(stored.sessions.filter(s => s.source === 'device-approval').length <= (cancelled ? 0 : 1));
    assert(['consumed', 'cancelled', 'approved'].includes((await devices.get(request.requestId)).status));
  });
});

test('chaos: concurrent recovery with one file starts one transaction; every earlier setup token and session is dead', async () => {
  await forEachSeed(25, async random => {
    const scheduler = createScheduler(random), base = new MemoryAccounts();
    const { act, service } = identityEngine({ repository: scheduler.wrap(base, 'accounts') });
    const { file, ownerContext, owner } = await activate(act), proof = { recoveryToken: file.recoveryToken, turnstileToken: 'verified' };
    const results = await scheduler.run([() => act('recover', proof), () => act('recover', proof), () => act('loginPassword', signupInput()), () => act('revokeOtherSessions', {}, ownerContext)]);
    const started = results.slice(0, 2).filter(r => r.status === 'fulfilled');
    assert(started.filter(r => r.value.resumed === false).length <= 1, 'one fresh recovery transaction');
    const stored = await base.get(owner.account.id);
    if (started.length) {
      assert.equal(stored.status, 'recovering'); assert.equal(stored.sessions.length, 0); assert.equal(stored.passwordHash, null);
      const live = [];
      for (const { value } of started) { try { await service.setupStatus({ pendingToken: value.pendingToken }, context); live.push(value); } catch (error) { assert.equal(error.code, 'unauthorized'); } }
      assert.equal(live.length, 1, `exactly the last committed setup token is live; trace ${scheduler.trace.join(' | ')}`);
      if (results[2].status === 'fulfilled') await assert.rejects(service.owner({}, sessionContext(results[2].value)), { code: 'unauthorized' });
      await assert.rejects(service.owner({}, ownerContext), { code: 'unauthorized' });
    } else assert.equal(stored.status, 'active');
  });
});

test('chaos: storage faults during account operations keep invariants and the account heals once storage recovers', async () => {
  await forEachSeed(20, async random => {
    let enabled = false;
    const modes = ['throw', 'after', 'duplicate', 'timeout'], rules = ['get', 'compareAndSwap', 'findByHandle'].flatMap(method => modes.map(mode => ({ method, mode, when: () => enabled && random.chance(0.05) })));
    const base = new MemoryAccounts(), clock = fakeClock(), { act, service } = identityEngine({ repository: injectFaults(base, rules, { random }), clock });
    const { owner } = await activate(act), id = owner.account.id, sessions = [owner];
    let lastRevision = (await base.get(id)).revision;
    enabled = true;
    for (let step = 0; step < 30; step++) {
      clock.advance(random.int(60000));
      const pick = random.int(4), live = random.pick(sessions);
      try {
        if (pick === 0) sessions.push(await act('loginPassword', signupInput()));
        else if (pick === 1) await act('logout', {}, sessionContext(live));
        else if (pick === 2) await act('renameSession', { sessionId: live.sessionContext, label: `Device ${step}` }, sessionContext(live));
        else await service.owner({}, sessionContext(live));
      } catch (error) { assert(['conflict', 'unauthorized', 'not_found', 'injected_fault', 'timeout', 'reauthentication_required'].includes(error.code), `unexpected failure ${error.code ?? error.message}`); }
      const stored = await base.get(id);
      assert(stored.revision >= lastRevision, 'revisions never go backwards'); lastRevision = stored.revision;
      assert(stored.sessions.length <= 10 && stored.audit.length <= 100, 'bounded state under faults');
      const serialized = JSON.stringify(stored);
      assert(!serialized.includes(PASSWORD) && sessions.every(s => !serialized.includes(s.sessionToken)), 'no plaintext secrets at rest');
    }
    enabled = false;
    const fresh = await act('loginPassword', signupInput());
    assert.equal((await service.owner({}, sessionContext(fresh))).account.id, id);
    assert.deepEqual(await act('logout', {}, sessionContext(fresh)), { loggedOut: true });
  });
});

// The sharded repository is the durable identity authority. Its prepare/settle/
// finish protocol must survive interleavings and lost or failed shard RPCs.
const SHARD_METHODS = ['shardPrepare', 'shardSettle', 'shardFinish', 'shardClaim', 'shardRelease', 'shardHandleConsume', 'shardHandleGrandfather', 'shardRead', 'shardLookup'];
test('chaos: sharded identity storage keeps handles permanent and emails unique through interleavings and lost shard RPCs', async () => {
  await forEachSeed(30, async random => {
    let enabled = true;
    const scheduler = createScheduler(random), rules = SHARD_METHODS.flatMap(method => [
      { method, mode: 'after', when: () => enabled && random.chance(0.06) },
      { method, mode: 'throw', when: () => enabled && random.chance(0.04) },
    ]);
    const shards = memoryShards({ wrap: (stub, name) => scheduler.wrap(injectFaults(stub, rules, { random }), name) }), repository = shards.repository();
    const handles = ['shared-a', 'shared-b'], emails = ['one@mail.example', 'two@mail.example'], owners = Array.from({ length: 5 }, (_, i) => `owner-${i}`);
    const created = new Map();
    const work = owners.map(id => async () => {
      const handle = random.pick(handles), value = { id, handle, revision: 0, status: 'active', verifiedEmail: random.chance(0.5) ? random.pick(emails) : null };
      if (await repository.create(value)) created.set(id, handle);
      const current = await repository.get(id);
      if (current) await repository.compareAndSwap(id, current.revision, { ...current, revision: current.revision + 1, verifiedEmail: random.pick([...emails, null]) });
    });
    await scheduler.run(work);
    enabled = false;
    const recovered = shards.repository(), accounts = (await Promise.all(owners.map(id => recovered.get(id)))).filter(Boolean);
    const trace = () => `trace ${scheduler.trace.slice(-12).join(' | ')}`;
    for (const [id, handle] of created) assert.equal(accounts.find(a => a.id === id)?.handle, handle, `confirmed create lost; ${trace()}`);
    for (const handle of handles) {
      const holders = accounts.filter(a => a.handle === handle);
      assert(holders.length <= 1, `handle ${handle} held twice; ${trace()}`);
      const found = await recovered.findByHandle(handle);
      assert.equal(found?.id ?? null, holders[0]?.id ?? null, `lookup disagrees with records for ${handle}`);
      // A handle that ever had a holder is permanently burned; one no create ever consumed may still be free.
      const late = await recovered.create({ id: `late-${handle}`, handle, revision: 0, status: 'active', verifiedEmail: null });
      if (holders.length || [...created.values()].includes(handle)) assert.equal(late, false, `held handle ${handle} was recycled; ${trace()}`);
    }
    for (const email of emails) {
      const holders = accounts.filter(a => a.verifiedEmail === email);
      assert(holders.length <= 1, `email ${email} owned twice; ${trace()}`);
      assert.equal((await recovered.findByEmail(email))?.id ?? null, holders[0]?.id ?? null);
    }
    for (const controller of shards.controllers.values()) for (const [key, value] of controller.metadata.rows)
      if (key.startsWith('identity-record/') && value.value) assert.equal(value.pending, undefined, `${key} left pending after recovery reads`);
  });
});

test('chaos: at-least-once shard RPC delivery never reports a committed create or update as a conflict', async () => {
  for (const method of SHARD_METHODS) {
    let duplicate = false;
    const shards = memoryShards({ wrap: stub => injectFaults(stub, [{ method, mode: 'duplicate', when: () => duplicate }]) }), repository = shards.repository();
    assert(await repository.create({ id: 'a', handle: 'alpha', revision: 0, status: 'active', verifiedEmail: null }));
    duplicate = true;
    assert.equal(await repository.create({ id: 'b', handle: 'beta', revision: 0, status: 'active', verifiedEmail: 'b@mail.example' }), true, `${method}: create`);
    assert.equal(await repository.compareAndSwap('a', 0, { id: 'a', handle: 'alpha', revision: 1, status: 'active', verifiedEmail: null }), true, `${method}: session-path update`);
    assert.equal(await repository.compareAndSwap('a', 1, { id: 'a', handle: 'alpha', revision: 2, status: 'active', verifiedEmail: 'a@mail.example' }), true, `${method}: lookup-changing update`);
    assert.equal(await repository.compareAndSwap('a', 1, { id: 'a', handle: 'alpha', revision: 2, status: 'stale', verifiedEmail: null }), false, `${method}: a stale revision still conflicts`);
    duplicate = false;
    assert.equal((await repository.get('a')).revision, 2); assert.equal((await repository.findByEmail('a@mail.example')).id, 'a');
    assert.equal((await repository.findByHandle('beta')).id, 'b'); assert.equal((await repository.findByEmail('b@mail.example')).id, 'b');
  }
});

test('scaling: storage per account stays constant under repeated updates and allocation stays unique across 64 lanes', async () => {
  const shards = memoryShards(), repository = shards.repository(), rows = () => [...shards.controllers.values()].reduce((sum, c) => sum + c.metadata.rows.size, 0);
  const total = 200;
  await Promise.all(Array.from({ length: total }, (_, i) => repository.create({ id: `bulk-${i}`, handle: `bulk-${i}`, revision: 0, status: 'active', verifiedEmail: `bulk-${i}@mail.example` })));
  const baseline = rows();
  assert(baseline <= total * 4, `a small constant number of rows per account (${baseline / total})`);
  let account = await repository.get('bulk-0');
  for (let i = 0; i < 60; i++) { const next = { ...account, revision: account.revision + 1, verifiedEmail: `rotating-${i % 3}@mail.example`, sessions: [i] }; assert(await repository.compareAndSwap(account.id, account.revision, next)); account = next; }
  assert.equal(rows(), baseline, 'email rotation releases old claims; updates add no residue');
  assert.equal(await repository.findByEmail('bulk-0@mail.example'), null);
  const allocated = await Promise.all(Array.from({ length: 256 }, (_, i) => repository.allocateFreeHandle(undefined, `alloc-${i}`)));
  assert.equal(new Set(allocated).size, 256);
  let cursor, seen = new Set(), pages = 0;
  do { const page = await repository.lifecycleCandidates({ cursor, limit: 25 }); for (const a of page.accounts) { assert(!seen.has(a.id), 'pagination never repeats'); seen.add(a.id); } cursor = page.cursor; pages++; } while (cursor && pages < 1000);
  assert.equal(seen.size, total); assert(pages >= 64 && pages < 1000);
});

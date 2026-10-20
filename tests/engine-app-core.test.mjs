// Engine core seams (docs/architecture/app-engine.md): the owner binding in the lease, completion
// semantics of `perform`, declared operation policy, and the account RPC reading that policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEngine, OWNER, OTHER, ownerActor } from './helpers/app-engine.mjs';
import { operations, operationPolicy, AppAction } from '../packages/app/engine.mjs';
import { ACCOUNT_OPERATIONS } from '../packages/app/operations.mjs';
import { SavedViews, CreateView } from '../packages/app/domains/views.mjs';
import { TagRules } from '../packages/app/domains/tags.mjs';
import { lifecycleBlocked } from '../packages/runtime/lifecycle-runner.mjs';
import { SqliteMetadata, SerialGate } from '../apps/node/resources.mjs';
import { AccountController } from '../packages/runtime/accounts.mjs';

test('a store bound to one owner refuses every other owner during the lease, whoever dispatches', async t => {
  const e = await createTestEngine(); t.after(() => e.dispose());
  await e.metadata.put('owner', OWNER);
  assert.equal((await e.read(new SavedViews({ actor: ownerActor() }))).views.length, 3);
  await assert.rejects(e.read(new SavedViews({ actor: ownerActor(OTHER) })), { code: 'forbidden', status: 403 });
  await assert.rejects(e.read(new TagRules({ actor: ownerActor(OTHER) })), { code: 'forbidden' });
  await assert.rejects(e.perform(new CreateView({ actor: ownerActor(OTHER), input: { name: 'x', filter: { version: 1 } } })), { code: 'forbidden' });
  assert.equal(e.events.length, 0);
});

test('perform resolves only after the interceptors unwound; a hook failing on the way out fails the call', async t => {
  const order = [], e = await createTestEngine({ interceptors: [{ leave(_, ctx) { order.push('leave'); if (ctx.action.input?.name === 'fail') throw Object.assign(new Error('unwind failed'), { code: 'leave_failed' }); } }] });
  t.after(() => e.dispose());
  await e.perform(new CreateView({ actor: ownerActor(), input: { name: 'ok', filter: { version: 1 } } })).then(() => order.push('resolved'));
  assert.deepEqual(order, ['leave', 'resolved']);
  await assert.rejects(e.perform(new CreateView({ actor: ownerActor(), input: { name: 'fail', filter: { version: 1 } } })), { code: 'leave_failed' });
});

test('operations declare placement policy; the registry refuses unknown values', () => {
  assert.deepEqual(operationPolicy(ACCOUNT_OPERATIONS, 'views.create'), { lifecycle: 'active', gate: 'account' });
  assert.deepEqual(operationPolicy(ACCOUNT_OPERATIONS, 'nope'), {});
  class Lookup extends AppAction { static operation = 'test.lookup'; static lifecycle = 'suspended'; static gate = 'none'; static activity = 'resource-use'; }
  assert.deepEqual(operationPolicy(operations(Lookup), 'test.lookup'), { lifecycle: 'suspended', gate: 'none', activity: 'resource-use' });
  class Odd extends AppAction { static operation = 'test.odd'; static gate = 'sometimes'; }
  assert.throws(() => operations(Odd), /unknown policy/);
  assert.throws(() => operations(Lookup, Lookup), /Duplicate/);
});

test('the lifecycle fence reads an operation level, and the account RPC applies it to dispatch', async t => {
  const metadata = new SqliteMetadata(':memory:'); t.after(() => metadata.close());
  const config = { LIFECYCLE_ENABLED: 'true', LIFECYCLE_DRY_RUN: 'false' }, c = { metadata, config };
  await metadata.put('lifecycle/state-v1', { phase: 'suspended' });
  assert.equal((await lifecycleBlocked(c, 'dispatch', { lifecycle: 'active' })).code, 'account_suspended');
  assert.equal(await lifecycleBlocked(c, 'dispatch', { lifecycle: 'suspended' }), null);
  await metadata.put('lifecycle/state-v1', { phase: 'purging' });
  assert.equal((await lifecycleBlocked(c, 'dispatch', { lifecycle: 'suspended' })).code, 'account_deleting');
  assert.equal(await lifecycleBlocked(c, 'dispatch', { lifecycle: 'purging' }), null);
  await metadata.put('lifecycle/state-v1', { phase: 'suspended' });
  const blobs = { put: async () => {}, get: async () => null, delete: async () => {} };
  const controller = new AccountController({ metadata, gate: new SerialGate(), blobs, archives: blobs, sql: metadata.sql, config: { APP_ORIGIN: 'https://space.example', KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), WORK_LIMITS_ENABLED: 'false', STORAGE_WRITE_ENABLED: 'false', ...config } });
  assert.equal((await controller.invoke({ method: 'dispatch', args: [OWNER, { operation: 'views.list' }] })).$fault.code, 'account_suspended');
  assert.equal((await controller.invoke({ method: 'dispatch', args: [OWNER, { operation: 'views.nope' }] })).$fault.code, 'account_suspended', 'unknown operations get the strictest level');
});

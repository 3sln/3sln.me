// Engine-level client tests: the production bl/accounts.mjs Actions dispatched
// through a real ngin Engine (tests/helpers/client-engine.mjs) with the real
// browser-state provider and fake api/browser providers. No rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientEngine, deferred, turn } from '../helpers/client-engine.mjs';
const { OpenAccounts, SwitchAccount, AddAccount, LogoutAccounts } = await import('../../apps/web/src/bl/accounts.mjs');

const A = '550e8400-e29b-41d4-a716-446655440001', B = '550e8400-e29b-41d4-a716-446655440002', REVISION = 'r'.repeat(43);
const member = (id, handle, sessionContext) => ({ account: { id, handle, verifiedEmail: 'never-projected@example.invalid' }, sessionContext, expiresAt: Date.now() + 3600000 });
const inventory = (accounts = [member(A, 'n.one', 'ctx-a'), member(B, 'n.two', 'ctx-b')]) => ({ accounts, revision: REVISION, pickerToken: 'picker-proof', activeOwner: A, limit: 5 });
const signedIn = { session: { account: { id: A, handle: 'n.one' }, sessionContext: 'ctx-a' }, beamGeneration: 1, data: { messages: ['private to A'] }, view: 'inbox' };
async function client(t, { routes = {}, state = signedIn } = {}) {
  const c = await createClientEngine({ state, routes: { 'GET /api/auth/accounts': () => inventory(), ...routes } });
  c.api.setContext({ account: { id: A }, sessionContext: 'ctx-a', csrfToken: 'csrf-a' });
  t.after(() => c.dispose());
  return c;
}

test('opening the picker projects handles only; the picker proof stays in browser memory', async t => {
  const c = await client(t);
  await c.dispatch(new OpenAccounts());
  const s = await c.snapshot();
  assert.equal(s.accountPicker, true); assert.equal(s.accountsLoading, false);
  assert.deepEqual(s.browserAccounts.accounts.map(row => row.account), [{ id: A, handle: 'n.one' }, { id: B, handle: 'n.two' }]);
  assert.equal(JSON.stringify(s).includes('picker-proof'), false); assert.equal(JSON.stringify(s).includes('never-projected'), false);
  assert.equal(c.browser.secrets.accountPickerToken, 'picker-proof');
  assert.deepEqual(c.api.calls.map(call => [call.method, call.path, call.context]), [['GET', '/api/auth/accounts', null]], 'inventory requests carry no account context');
  assert.ok(c.facts.includes('browser-state-updated'));
});

test('switching tears down private state before the request, sends the original authority, then installs the target', async t => {
  let atRequest;
  const c = await client(t, { routes: {
    'POST /api/auth/accounts/switch': async () => { atRequest = await c.snapshot(); return { account: { id: B, handle: 'n.two' }, sessionContext: 'ctx-b', csrfToken: 'csrf-b' }; },
    'GET /api/account': () => ({ messages: ['private to B'] }),
  } });
  await c.dispatch(new OpenAccounts());
  await c.dispatch(new SwitchAccount({ owner: B }));
  assert.equal(atRequest.data, null); assert.equal(atRequest.session, null); assert.equal(atRequest.busy, true);
  const request = c.api.calls.find(call => call.path === '/api/auth/accounts/switch');
  assert.deepEqual(request.body, { owner: B, expectedRevision: REVISION, pickerToken: 'picker-proof' });
  assert.deepEqual(request.context, { owner: A, sessionContext: 'ctx-a', csrfToken: 'csrf-a' }, 'the tab authority captured before teardown');
  const s = await c.snapshot();
  assert.deepEqual(s.session, { account: { id: B, handle: 'n.two' }, sessionContext: 'ctx-b' });
  assert.deepEqual(s.data, { messages: ['private to B'] }); assert.equal(s.accountPicker, false); assert.equal(s.busy, false);
  assert.deepEqual(c.api.captureContext(), { owner: B, sessionContext: 'ctx-b', csrfToken: 'csrf-b' });
  assert.ok(c.browser.effects.some(([name]) => name === 'announceAccounts'));
});

test('a switch overtaken by another account transition never installs its late result', async t => {
  const held = deferred();
  const c = await client(t, { routes: { 'POST /api/auth/accounts/switch': () => held.promise, 'GET /api/account': () => ({ messages: ['private to B'] }) } });
  await c.dispatch(new OpenAccounts());
  const switching = c.dispatch(new SwitchAccount({ owner: B }));
  while (!c.api.calls.some(call => call.path === '/api/auth/accounts/switch')) await turn();
  await c.dispatch(new AddAccount());
  held.resolve({ account: { id: B, handle: 'n.two' }, sessionContext: 'ctx-b', csrfToken: 'csrf-b' });
  await switching;
  const s = await c.snapshot();
  assert.equal(s.session, null); assert.equal(s.addingAccount, true); assert.equal(s.data, null);
  assert.equal(c.api.account, null, 'the late result did not install B as the request context');
  assert.equal(c.api.calls.some(call => call.path === '/api/account'), false);
});

test('a changed member snapshot is shown for review and the dispatch still completes', async t => {
  let inventories = 0;
  const c = await client(t, { routes: {
    'GET /api/auth/accounts': () => { inventories++; return inventory(); },
    'POST /api/auth/accounts/switch': () => { throw Object.assign(new Error('changed'), { code: 'vault_conflict', status: 409 }); },
  } });
  await c.dispatch(new OpenAccounts());
  await c.dispatch(new SwitchAccount({ owner: B }));
  const s = await c.snapshot();
  assert.equal(s.accountPicker, true); assert.equal(s.busy, false); assert.match(s.error, /account list changed/);
  assert.equal(inventories, 2, 'the fresh list is loaded for review, never retried silently');
  assert.equal(c.api.calls.filter(call => call.path === '/api/auth/accounts/switch').length, 1);
});

test('signing out another saved account keeps this tab account and its data', async t => {
  const c = await client(t, { routes: { 'POST /api/auth/accounts/logout': () => ({ cleanupPending: false, accountsRemaining: 1 }) } });
  await c.dispatch(new OpenAccounts());
  c.api.routes['GET /api/auth/accounts'] = () => inventory([member(A, 'n.one', 'ctx-a')]);
  await c.dispatch(new LogoutAccounts({ owner: B }));
  const s = await c.snapshot();
  assert.deepEqual(s.session.account, { id: A, handle: 'n.one' }); assert.deepEqual(s.data, signedIn.data);
  assert.equal(s.notice, 'Signed out.'); assert.deepEqual(s.browserAccounts.accounts.map(row => row.account.id), [A]);
  assert.deepEqual(c.api.calls.find(call => call.path === '/api/auth/accounts/logout').body, { owner: B, expectedRevision: REVISION, pickerToken: 'picker-proof' });
});

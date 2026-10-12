import test from 'node:test';
import assert from 'node:assert/strict';
import { BindleEngine, STORAGE } from '../packages/core/engine.mjs';
function fixture() {
  let now = 1000;
  const e = new BindleEngine({ clock: () => now });
  const resource = e.addStorage('alice', 'Storage'); e.configure('alice', [resource]);
  const issue = options => e.consent('alice', 'app', { acknowledged: true, ...options });
  const call = (token, method, args = {}, tx = 'tx1') => e.rpc(token, { tx, resource, contract: STORAGE, method, args });
  return { e, resource, issue, call, advance: () => { now += 3600001; } };
}
test('explicit consent and resource ownership are required', () => {
  const {e, resource} = fixture();
  assert.throws(() => e.consent('alice', 'app'), { code: 'consent_required' });
  assert.throws(() => e.configure('bob', [resource]), { code: 'invalid_resource' });
});
test('read-only grant cannot write; revocation affects existing tokens immediately', () => {
  const {e, issue, call} = fixture(); const {access_token, grant} = issue();
  assert.throws(() => call(access_token, 'put', {key:'a',value:'b',ifMatch:null}), {code:'forbidden'});
  assert.deepEqual(call(access_token, 'list').result, {objects:[]});
  e.revoke('alice', grant.id);
  assert.throws(() => call(access_token, 'list'), {code:'unauthorized'});
});
test('assignment changes remove access and do not silently add new resources', () => {
  const {e, resource, issue, call} = fixture(); const {access_token} = issue();
  e.configure('alice', []);
  assert.throws(() => call(access_token, 'list'), {code:'forbidden'});
  e.configure('alice', [resource]);
  assert.throws(() => call(access_token, 'list'), {code:'forbidden'});
  const added = e.addStorage('alice','New'); e.configure('alice',[added]);
  assert.throws(() => e.rpc(access_token,{tx:'new',resource:added,contract:STORAGE,method:'list'}),{code:'forbidden'});
});
test('writes require version match; transaction replay is idempotent and collisions fail', () => {
  const {issue, call} = fixture(); const {access_token} = issue({methods:['get','put','delete','list']});
  const args = {key:'file',value:'one',ifMatch:null};
  const first = call(access_token,'put',args);
  assert.deepEqual(call(access_token,'put',args),first);
  assert.throws(() => call(access_token,'put',{...args,value:'two'}),{code:'transaction_conflict'});
  assert.throws(() => call(access_token,'put',args,'second'),{code:'precondition_failed'});
  const updated = call(access_token,'put',{key:'file',value:'two',ifMatch:first.result.etag},'update');
  assert.equal(call(access_token,'get',{key:'file'},'read').result.value,'two');
  assert.notEqual(updated.result.etag,first.result.etag);
});
test('expiry is enforced even for cached transaction responses', () => {
  const {issue,call,advance} = fixture(); const {access_token} = issue();
  call(access_token,'list'); advance();
  assert.throws(() => call(access_token,'list'),{code:'unauthorized'});
});

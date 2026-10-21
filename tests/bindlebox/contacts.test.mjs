// BB-B2 contacts: contact parents through the links contract, edge publication, revocation, contacts added from a
// link, blocks and conditional-link decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,P,uuidOf} from './receive-fixtures.test.mjs';
import {parseLinkURL} from '../../packages/bindlebox-engine/domains/contacts.mjs';
import {edgeKey} from '../../packages/bindlebox-engine/store/edge-index.mjs';

const fresh=async t=>{const w=await createWorld();t.after(()=>w.dispose());return w;};
const code=(r,status,error)=>{assert.equal(r.status,status,JSON.stringify(r.json));assert.equal(r.json.error,error);};

test('creating a link stores the exact issued claims and publishes a digest-only edge entry, idempotently',async t=>{
 const w=await fresh(t),created=await w.run('bob','contacts.create-link',{label:'Website',kinds:['conversation-init','one-off']});
 assert.equal(created.revoked,false);assert.deepEqual(created.kinds,['conversation-init','one-off']);
 // Not routable until the outbox is flushed; flushing twice publishes once and empties the outbox.
 const meta=new URL(created.link).searchParams.get('bindle_meta'),link={...created,meta};
 code(await w.deliver('alice','bob',link),401,'link_invalid');
 assert.equal(await w.flush('bob'),1);assert.equal(await w.flush('bob'),0);
 const entry=await w.edge.get(P.bob.principal.issuer,created.jti);assert.deepEqual(Object.keys(entry).sort(),['claimsDigest','generation','owner','revoked']);
 assert.equal(JSON.stringify(entry).includes(meta.split('.')[1]),false,'no meta material in the index');
 assert.equal((await w.deliver('alice','bob',link)).status,200);
 // An older generation or another owner cannot overwrite the entry.
 assert.equal(await w.edge.publish({iss:P.bob.principal.issuer,jti:created.jti,owner:w.peer('carol').owner,claimsDigest:'x',revoked:false,generation:99}),false);
 assert.equal(await w.edge.publish({iss:P.bob.principal.issuer,jti:created.jti,owner:w.peer('bob').owner,claimsDigest:'x',revoked:true,generation:0}),false);
 // The provider returning an unexpected meta is refused and nothing is stored.
 const issue=w.links.bob.issue;w.links.bob.issue=async request=>issue({...request,claims:{...request.claims,maxMessages:7}});
 await assert.rejects(w.run('bob','contacts.create-link',{}),{code:'links_unavailable'});w.links.bob.issue=issue;
 assert.equal((await w.run('bob','contacts.list')).links.length,1);
});

test('revocation applies locally first, even when the provider call fails, and stays revoked through the edge',async t=>{
 const w=await fresh(t),link=await w.link('bob');assert.equal((await w.deliver('alice','bob',link)).status,200);
 w.links.bob.state.down.add('revoke');
 const revoked=await w.run('bob','contacts.revoke-link',{jti:link.jti});assert.equal(revoked.revoked,true);assert.equal(revoked.providerRevoke,'pending');assert.equal(revoked.link,null);
 // Before the edge learns of it, the mailbox itself refuses (a stale index only costs work).
 code(await w.deliver('alice','bob',link,{operationId:uuidOf(2)}),401,'link_invalid');
 // A replay of the earlier delivery no longer retrieves its receipt.
 code(await w.deliver('alice','bob',link),401,'link_invalid');
 await w.flush('bob');assert.equal((await w.edge.get(P.bob.principal.issuer,link.jti)).revoked,true);
 const before=w.delivered.count;code(await w.deliver('alice','bob',link,{operationId:uuidOf(3)}),401,'link_invalid');assert.equal(w.delivered.count,before,'refused at the edge');
 w.links.bob.state.down.delete('revoke');assert.equal((await w.run('bob','contacts.revoke-link',{jti:link.jti})).providerRevoke,'revoked');
 // The provider's own linkRevoked notice (system actor) is accepted; an ingress actor cannot revoke.
 const second=await w.link('bob');assert.equal((await w.system('bob','contacts.revoke-link',{jti:second.jti})).providerRevoke,'revoked');
 const bob=w.peer('bob'),{ContactsRevokeLink}=await import('../../packages/bindlebox-engine/domains/contacts.mjs');
 await assert.rejects(bob.engine.perform(new ContactsRevokeLink({actor:{kind:'ingress',owner:bob.owner},input:{jti:second.jti}})),{code:'unauthorized'});
 await assert.rejects(w.run('bob','contacts.revoke-link',{jti:'jti-missing'}),{code:'not_found'});
});

test('contacts are added from a link by the links §2 raw-query rules and stored canonically as unverified claims',async t=>{
 const w=await fresh(t),alice=await w.run('alice','contacts.create-link',{}),url=alice.link;
 const added=await w.run('bob','contacts.add',{link:`${url}&utm_campaign=x#frag`,label:'Alice'});
 assert.deepEqual(added.principal,{issuer:P.alice.principal.issuer,subject:P.alice.principal.subject});assert.equal(added.verified,false);
 assert.equal(added.link.includes('utm_'),false);assert.equal(added.link.endsWith(new URL(url).searchParams.get('bindle_meta')),true);
 assert.equal((await w.run('bob','contacts.add',{link:url})).id,added.id,'adding the same link twice is idempotent');
 const meta=new URL(url).searchParams.get('bindle_meta'),base=url.split('?')[0];
 for(const bad of [`${base}?bindle_x=1&bindle_meta=${meta}`,`${base}?Bindle_meta=${meta}`,`${base}?bindle%5Fmeta=${meta}`,`${base}?bindle_meta=${meta}&bindle_meta=${meta}`,`${base}?sig=abc&bindle_meta=${meta}`,`${base}?bindle_meta=${meta}%3D`,`http://alice.provider.example/x?bindle_meta=${meta}`,`${base}/moved?bindle_meta=${meta}`,`${base}#bindle_meta=${meta}`])
  await assert.rejects(w.run('bob','contacts.add',{link:bad}),{code:'invalid_input'},bad);
 assert.equal(parseLinkURL(`${base}?a=1&&bindle_meta=${meta}&b`).meta,meta);
 await assert.rejects(w.run('bob','contacts.add',{link:(await w.run('bob','contacts.create-link',{})).link}),{code:'invalid_input'},'own link');
 w.clock.advance(31*86400000);await assert.rejects(w.run('carol','contacts.add',{link:url}),{code:'invalid_input'},'expired');
 const list=await w.run('bob','contacts.list');assert.equal(list.contacts.length,1);
 assert.deepEqual(await w.run('bob','contacts.remove',{id:added.id}),{id:added.id,removed:true});assert.equal((await w.run('bob','contacts.list')).contacts.length,0);
 assert.equal(await w.peer('bob').store.get(`known/${encodeURIComponent(P.alice.principal.issuer)}|${P.alice.principal.subject}`),undefined);
});

test('blocks refuse a principal on every link and invalidate reused conditional decisions',async t=>{
 const w=await fresh(t),open=await w.link('bob'),gated=await w.link('bob',{conditional:true});
 assert.equal((await w.deliver('alice','bob',gated)).status,200);assert.equal((await w.deliver('alice','bob',gated,{operationId:uuidOf(2)})).status,200);
 assert.equal(w.links.bob.calls.evaluate,1,'a positive decision is reused until the UTC day ends');
 await w.run('bob','contacts.block',{principal:P.alice.principal});
 code(await w.deliver('alice','bob',open,{operationId:uuidOf(3)}),403,'not_authorized');code(await w.deliver('alice','bob',gated,{operationId:uuidOf(4)}),403,'not_authorized');
 await w.run('bob','contacts.block',{principal:P.alice.principal,blocked:false});
 assert.equal((await w.deliver('alice','bob',gated,{operationId:uuidOf(5)})).status,200);assert.equal(w.links.bob.calls.evaluate,2,'the block dropped the reused decision');
 // Ineligible is cached for 15 minutes; unavailable is never cached and is retryable.
 w.links.bob.state.policy=p=>p.subject===P.carol.principal.subject?'ineligible':'eligible';
 code(await w.deliver('carol','bob',gated,{operationId:uuidOf(6)}),403,'audience_ineligible');code(await w.deliver('carol','bob',gated,{operationId:uuidOf(7)}),403,'audience_ineligible');assert.equal(w.links.bob.calls.evaluate,3);
 w.links.bob.state.policy=()=>'eligible';w.clock.advance(900001);w.links.bob.state.down.add('evaluate');
 const down=await w.deliver('carol','bob',gated,{operationId:uuidOf(8),createdAt:w.clock.now()-1000});code(down,503,'audience_unavailable');assert.equal(down.headers.get('retry-after'),'60');
 w.links.bob.state.down.delete('evaluate');assert.equal((await w.deliver('carol','bob',gated,{operationId:uuidOf(8),createdAt:w.clock.now()-1000})).status,200);
});

test('conditional quotas are per verified author per UTC day; owner operations reject other actor kinds',async t=>{
 const w=await fresh(t),gated=await w.link('bob',{conditional:true,maxMessages:2});
 for(const n of [1,2])assert.equal((await w.deliver('alice','bob',gated,{operationId:uuidOf(n)})).status,200);
 const limited=await w.deliver('alice','bob',gated,{operationId:uuidOf(3)});code(limited,429,'rate_limited');assert.ok(Number(limited.headers.get('retry-after'))>0);
 assert.equal((await w.deliver('carol','bob',gated,{operationId:uuidOf(4)})).status,200,'another author has its own quota');
 const bob=w.peer('bob'),{ContactsCreateLink}=await import('../../packages/bindlebox-engine/domains/contacts.mjs');
 for(const kind of ['ingress','system'])await assert.rejects(bob.engine.perform(new ContactsCreateLink({actor:{kind,owner:bob.owner},input:{}})),{code:'unauthorized'});
 await assert.rejects(bob.engine.perform(new ContactsCreateLink({actor:{kind:'owner',owner:w.peer('alice').owner},input:{}})),{code:'forbidden'});
 assert.ok(edgeKey('https://a.example','x/y').includes('x%2Fy'));
});

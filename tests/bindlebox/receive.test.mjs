// BB-B2 receive path over the seeded network simulator: admission order, honest receipts, replay, forged authors,
// revoked app keys, budget exhaustion, crash/restart idempotency and dead hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,P,B,NOW,INGRESS,uuidOf,encoder,keys} from './receive-fixtures.test.mjs';
import {claimsFor} from './vectors/fixtures.mjs';
import {concurrently} from '../helpers/chaos.mjs';

const fresh=async(t,options)=>{const w=await createWorld(options);t.after(()=>w.dispose());return w;};
const code=(r,status,error)=>{assert.equal(r.status,status,JSON.stringify(r.json));assert.equal(r.json.error,error);};

test('a one-off is admitted once with a custody receipt the sender verifies; identical retries replay it without a charge',async t=>{
 const w=await fresh(t),link=await w.link('bob'),r=await w.deliver('alice','bob',link,{},{idempotencyKey:uuidOf(1)});
 assert.equal(r.status,200);assert.deepEqual(Object.keys(r.json),['receipt']);assert.equal(r.headers.get('cache-control'),'no-store');
 const verified=await w.verify('bob',r,r.json.receipt);assert.equal(verified.state,'delivered');
 assert.equal(r.json.receipt.payload.receivedAt,w.clock.now());assert.equal(r.json.receipt.payload.ingress,INGRESS.bob);
 const budget=await w.budget('bob'),again=await w.post('alice','bob',r.request);
 assert.deepEqual(again.json,r.json);assert.deepEqual(await w.budget('bob'),budget,'a replay is never charged');
 assert.equal((await w.items('bob')).length,1);const listed=await w.run('bob','receive.items');assert.equal(listed.items[0].author.principal.subject,P.alice.principal.subject);
 // Same operation, different content: conflict. Idempotency-Key must equal the operation ID.
 code(await w.deliver('alice','bob',link,{body:encoder.encode('different')}),409,'operation_conflict');
 code(await w.deliver('alice','bob',link,{operationId:uuidOf(2)},{idempotencyKey:uuidOf(3)}),400,'malformed');
 // The receipt never claims anything for another recipient: Carol shares the hub but it does not verify for her.
 assert.equal((await B.verifyReceipt(r.json.receipt,{obligation:{principal:P.carol.principal,ingress:INGRESS.carol,operationId:uuidOf(1),payloadDigest:await B.payloadDigest(r.envelope),bodyDigest:await B.sha256(crypto,r.body),kind:'one-off'},resolveKey:w.directory.resolveKey,status:w.directory.status,now:w.clock.now()})).state,'unknown');
});

test('bad link credentials are refused at the edge without waking a mailbox, uniformly',async t=>{
 const w=await fresh(t),link=await w.link('bob'),other=await w.link('bob'),before=w.delivered.count;
 const [h,p,s]=link.meta.split('.'),flip=s.slice(0,-2)+(s.at(-2)==='A'?'B':'A')+s.at(-1);
 const claims=JSON.parse(new TextDecoder().decode(B.fromBase64url(p)));
 const cases=[`BindleLink ${h}.${p}.${flip}`,`BindleLink ${h}.${B.base64url(encoder.encode(JSON.stringify({...claims,jti:'jti-unknown'})))}.${s}`,`BindleLink ${h}.${B.base64url(encoder.encode(JSON.stringify({...claims,maxMessages:9999})))}.${s}`];
 for(const authorization of cases){const built=await w.envelope('alice','bob',link);code(await w.post('alice','bob',w.request('bob',link,built,{authorization})),401,'link_invalid');}
 // A flipped signature with the same claims matches the edge digest, reaches the mailbox, and fails its signature check.
 assert.equal(w.delivered.count,before+1);
 code(await w.post('alice','bob',w.request('bob',link,await w.envelope('alice','bob',link),{authorization:'BindleLink not-a-jws'})),400,'link_malformed');
 code(await w.post('alice','bob',w.request('bob',link,await w.envelope('alice','bob',link),{authorization:`BindleConversation ${uuidOf(9)}.${'A'.repeat(43)}`})),403,'not_authorized');
 // Recipient binding (§4.5 step 4): an envelope addressed to the other link fails as link_invalid.
 code(await w.deliver('alice','bob',link,{operationId:uuidOf(3),recipient:{issuer:P.bob.principal.issuer,owner:P.bob.principal.subject,contactId:other.jti,resource:other.resource}}),401,'link_invalid');
 // Kind outside the link's kinds.
 code(await w.deliver('alice','bob',link,{kind:'conversation-init',operationId:uuidOf(4)}),401,'link_invalid');
 assert.deepEqual(await w.items('bob'),[]);assert.equal(await w.budget('bob'),undefined,'refusals before custody charge nothing');
});

test('forged authors fail before any status fetch, storage or charge',async t=>{
 const w=await fresh(t),link=await w.link('bob'),statusBefore=w.directory.calls.status;
 // Payload altered after signing.
 code(await w.deliver('alice','bob',link,{tamper:e=>{e.payload.subject='Altered';return e;}}),401,'author_unverifiable');
 // A certificate for Alice signed by Carol's identity key under Alice's kid.
 const forged=await B.encodeDelegation(claimsFor('alice',keys.alice.delegate,P.alice.jkt),{privateKey:P.carol.identityPrivate,keyId:P.alice.keyId});
 code(await w.deliver('alice','bob',link,{operationId:uuidOf(5),signer:{...P.alice.signer,delegation:forged}}),401,'author_unverifiable');
 // Carol's genuine key claiming Alice's principal.
 code(await w.deliver('alice','bob',link,{operationId:uuidOf(6),author:{...P.alice.author,delegate:P.carol.author.delegate},signer:P.carol.signer}),401,'author_unverifiable');
 // An author the directory cannot resolve.
 // (A restart clears the bounded key cache, which otherwise keeps Alice's key for 5 minutes.)
 const resolve=w.directory.resolveKey;w.directory.resolveKey=async q=>q.issuer===P.alice.principal.issuer?null:resolve(q);await w.network.recover('bob');
 code(await w.deliver('alice','bob',link,{operationId:uuidOf(7)}),401,'author_unverifiable');w.directory.resolveKey=resolve;
 assert.equal(w.directory.calls.status,statusBefore,'no status fetch for forged objects');assert.deepEqual(await w.items('bob'),[]);assert.equal(await w.budget('bob'),undefined);
});

test('revoked app keys: status-required kinds check live, others honour known revocations, and earlier items quarantine',async t=>{
 const w=await fresh(t),link=await w.link('bob',{kinds:['conversation-init','one-off']});
 const first=await w.deliver('alice','bob',link,{operationId:uuidOf(10)});assert.equal(first.status,200);
 // Status cannot be determined: 503 with Retry-After, nothing stored.
 w.directory.outage('status');const down=await w.deliver('alice','bob',link,{kind:'conversation-init',operationId:uuidOf(11)});code(down,503,'author_unverifiable');assert.equal(down.headers.get('retry-after'),'60');w.directory.restore('status');
 w.directory.revoke(P.alice.jkt,Math.floor(NOW/3600000));
 code(await w.deliver('alice','bob',link,{kind:'conversation-init',operationId:uuidOf(12)}),401,'author_unverifiable');
 const fetches=w.directory.calls.status;
 code(await w.deliver('alice','bob',link,{operationId:uuidOf(13)}),401,'author_unverifiable');assert.equal(w.directory.calls.status,fetches,'a known revocation needs no fetch');
 const items=await w.items('bob');assert.equal(items.length,1);assert.equal(items[0].quarantined.reason,'delegation_revoked');
 assert.deepEqual((await w.run('bob','receive.items')).items,[]);assert.equal((await w.run('bob','receive.items')).quarantined.length,1);
 // The revocation is durable: it survives a restart that clears every in-memory cache.
 await w.network.recover('bob');code(await w.deliver('alice','bob',link,{operationId:uuidOf(14)}),401,'author_unverifiable');assert.equal(w.directory.calls.status,fetches);
 // Even a byte-identical replay of the admitted envelope no longer yields its receipt.
 code(await w.post('alice','bob',first.request),401,'author_unverifiable');
});

test('budget exhaustion is a retryable 429 before custody; replays of admitted messages still answer',async t=>{
 const w=await fresh(t),link=await w.link('bob',{maxMessages:1000});let first;
 for(let i=0;i<30;i++){const r=await w.deliver('alice','bob',link,{operationId:uuidOf(100+i)});assert.equal(r.status,200,JSON.stringify(r.json));first??=r;}
 const limited=await w.deliver('alice','bob',link,{operationId:uuidOf(200)});code(limited,429,'rate_limited');assert.ok(Number(limited.headers.get('retry-after'))>=1&&Number(limited.headers.get('retry-after'))<=60);
 assert.deepEqual((await w.post('alice','bob',first.request)).json,first.json);assert.equal((await w.items('bob')).length,30);
 w.clock.advance(60000);assert.equal((await w.deliver('alice','bob',link,{operationId:uuidOf(200),createdAt:w.clock.now()-1000})).status,200);
 // Unconditional link lifetime quota: a spent link stops authorizing.
 const small=await w.link('bob',{maxMessages:1});assert.equal((await w.deliver('carol','bob',small,{operationId:uuidOf(300),createdAt:w.clock.now()-1000})).status,200);
 code(await w.deliver('carol','bob',small,{operationId:uuidOf(301),createdAt:w.clock.now()-1000}),401,'link_invalid');
});

test('crash and restart: rollback admits on retry, a lost reply replays the stored receipt, concurrent duplicates admit once',async t=>{
 for(const mode of ['throw','after']){
  const w=await fresh(t),link=await w.link('bob');
  w.peer('bob').faults={mailboxStore:[{method:'transaction',when:1,mode}]};await w.network.recover('bob');
  const lost=await w.deliver('alice','bob',link);assert.equal(lost.status,500);assert.deepEqual(Object.keys(lost.json),['error','message']);
  assert.equal((await w.items('bob')).length,mode==='after'?1:0,'the commit either happened or rolled back entirely');
  const retry=await w.post('alice','bob',lost.request);assert.equal(retry.status,200);assert.equal((await w.verify('bob',lost,retry.json.receipt)).state,'delivered');
  assert.equal((await w.items('bob')).length,1);assert.equal((await w.budget('bob')).windows.day.messages,1,'charged exactly once');
 }
 const w=await fresh(t),link=await w.link('bob'),built=await w.envelope('alice','bob',link),request=w.request('bob',link,built);
 const results=await concurrently(Array.from({length:6},()=>()=>w.post('alice','bob',request)));
 const receipts=results.map(r=>r.value.json);assert.ok(receipts.every(r=>JSON.stringify(r)===JSON.stringify(receipts[0])));
 assert.equal((await w.items('bob')).length,1);assert.equal((await w.budget('bob')).windows.day.messages,1);
 // Network-level response loss after commit, then host death and recovery: the retry is still idempotent.
 w.network.rules.push({from:'alice',to:'bob',when:7,mode:'after'});
 const r2=await w.envelope('alice','bob',link,{operationId:uuidOf(2)}),req2=w.request('bob',link,r2);
 await assert.rejects(w.network.send('alice','bob',req2),{code:'connection_reset'});
 w.network.kill('bob');await assert.rejects(w.network.send('alice','bob',req2),{code:'host_unavailable'});await w.network.recover('bob');
 const after=await w.post('alice','bob',req2);assert.equal(after.status,200);assert.equal((await w.items('bob')).length,2);assert.equal((await w.budget('bob')).windows.day.messages,2);
});

test('dead directory, clock skew, window and an unusable receipt key all refuse before custody',async t=>{
 const w=await fresh(t),link=await w.link('bob');
 w.directory.outage('directory');const down=await w.deliver('alice','bob',link);assert.equal(down.status,503);assert.equal(down.headers.get('retry-after'),'60');w.directory.restore('directory');
 const skew=await w.deliver('alice','bob',link,{createdAt:w.clock.now()+61000,operationId:uuidOf(20)});code(skew,400,'clock_skew');assert.equal(skew.json.serverTime,w.clock.now());
 code(await w.deliver('alice','bob',link,{createdAt:w.clock.now()-86400001,operationId:uuidOf(21)}),400,'envelope_expired');
 // A receipt key without the receipt purpose (or for another ingress) means no custody at all: 503, nothing stored.
 const bob=w.peer('bob');bob.signer={...P.bob.signer,delegation:await P.bob.issue({purposes:[B.PURPOSES.author]})};
 code(await w.deliver('alice','bob',link,{operationId:uuidOf(22)}),503,'recipient_unavailable');
 bob.signer={...P.bob.signer,delegation:await P.bob.issue({ingress:'https://other.box.example/ingress'})};
 code(await w.deliver('alice','bob',link,{operationId:uuidOf(23)}),503,'recipient_unavailable');
 // A kid paired with another key's certificate (the IDKEYS-1 race shape) is refused, never signed.
 bob.signer={...P.bob.signer,delegation:P.bob.renewed.delegation};code(await w.deliver('alice','bob',link,{operationId:uuidOf(24)}),503,'recipient_unavailable');
 delete bob.signer;assert.deepEqual(await w.items('bob'),[]);
 // Posting to another ingress than the configured one is ingress_moved.
 const built=await w.envelope('alice','bob',link,{operationId:uuidOf(25)});code(await w.post('alice','bob',{...w.request('bob',link,built),url:'https://elsewhere.box.example/ingress'}),410,'ingress_moved');
});

test('large bodies are staged in the owner storage resource first, else held in the bounded hot allowance',async t=>{
 const puts=[],storage={fail:false,async put(key,bytes){if(this.fail)throw new Error('storage down');puts.push([key,bytes.byteLength]);}};
 const w=await fresh(t,{userStorage:storage}),link=await w.link('bob'),big=encoder.encode('x'.repeat(5000));
 assert.equal((await w.deliver('alice','bob',link,{body:big})).status,200);assert.equal(puts.length,1);assert.ok(puts[0][0].startsWith('bindlebox/v1/items/'));
 let [item]=await w.items('bob');assert.equal(item.bodyRef.storage,'user');assert.equal(await w.peer('bob').store.get(`body/${item.id}`),undefined);
 storage.fail=true;assert.equal((await w.deliver('alice','bob',link,{body:big,operationId:uuidOf(2)})).status,200);
 item=(await w.items('bob')).find(i=>i.operationId===uuidOf(2));assert.equal(item.bodyRef.storage,'mailbox');assert.equal(item.hot,5000);
 assert.deepEqual(await w.peer('bob').store.get('usage/v1'),{hotBytes:5000,hotItems:1,rejected:0});
 // Small bodies stay inline and never count against the hot allowance.
 assert.equal((await w.deliver('alice','bob',link,{operationId:uuidOf(3)})).status,200);assert.equal((await w.peer('bob').store.get('usage/v1')).hotItems,1);
});

test('review regressions: refused attempts stage nothing, conflicts never overwrite bodies, verified refusals are limited before crypto',async t=>{
 const puts=new Map(),deleted=[],storage={async put(key,bytes){puts.set(key,B.base64url(bytes).slice(0,8));},async delete(key){deleted.push(key);puts.delete(key);}};
 const w=await fresh(t,{userStorage:storage}),spent=await w.link('bob',{maxMessages:1}),big=n=>encoder.encode(String(n).repeat(5000));
 assert.equal((await w.deliver('alice','bob',spent,{body:big(1)})).status,200);assert.equal(puts.size,1);const [[key,stored]]=[...puts];
 // BB2-R1: a spent link refuses before staging.
 for(let i=2;i<6;i++)code(await w.deliver('alice','bob',spent,{body:big(i),operationId:uuidOf(i)}),401,'link_invalid');assert.equal(puts.size,1);
 // BB2-R2: a conflicting retry of the admitted operation never touches its stored body.
 const open=await w.link('bob');assert.equal((await w.deliver('carol','bob',open,{body:big(7),operationId:uuidOf(70)})).status,200);
 code(await w.deliver('carol','bob',open,{body:big(8),operationId:uuidOf(70)}),409,'operation_conflict');assert.equal(puts.get(key),stored);assert.equal(puts.size,2);
 // A refusal found inside the commit discards the staged copy.
 const store=w.peer('bob').store,originalTx=store.transaction.bind(store);let once=true;
 store.transaction=work=>{if(once){once=false;return originalTx(async tx=>{await tx.put('block/'+encodeURIComponent(P.carol.principal.issuer)+'|'+encodeURIComponent(P.carol.principal.subject),{});return work(tx);}).catch(e=>{throw e;});}return originalTx(work);};
 code(await w.deliver('carol','bob',open,{body:big(9),operationId:uuidOf(71)}),403,'not_authorized');store.transaction=originalTx;
 assert.equal(deleted.length,1);assert.equal(puts.size,2);
 // BB2-R3: after 20 verified refusals a principal is refused before crypto, status or the links contract.
 const gated=await w.link('bob',{conditional:true});w.links.bob.state.policy=()=>'ineligible';
 // Alice already has 4 verified refusals (the spent link above); 16 more reach the limit of 20 per hour.
 for(let i=0;i<16;i++)code(await w.deliver('alice','bob',gated,{operationId:uuidOf(200+i),createdAt:w.clock.now()-1000}),403,'audience_ineligible');
 assert.equal(w.links.bob.calls.evaluate,1,'the negative decision is reused for 15 minutes');const evaluations=w.links.bob.calls.evaluate;w.clock.advance(900001);const limited=await w.deliver('alice','bob',gated,{operationId:uuidOf(300),createdAt:w.clock.now()-1000});
 code(limited,429,'rate_limited');assert.equal(w.links.bob.calls.evaluate,evaluations);
 assert.equal((await w.deliver('carol','bob',gated,{operationId:uuidOf(301),createdAt:w.clock.now()-1000})).json.error,'audience_ineligible','other principals are unaffected');
});

// BB-B2 public-request intake: spam tiers, calibration mode, heuristics without a classifier, allowlist overrides,
// the bounded recoverable Rejected view, bridged intake and storms against the per-sender/domain/owner limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,bridgeConsumer,P,uuidOf,encoder} from './receive-fixtures.test.mjs';
import {minimize,decideTier,T_HIGH} from '../../packages/bindlebox-engine/domains/intake.mjs';
import {INTAKE_CONTRACT} from '../../packages/bindlebox-protocol/index.mjs';

const MODEL={model:'spamnet',version:'3',schema:'labels-v1'};
// Fake classifier occupant: the score is read from a `p=` marker in the (already minimized) text.
const classifier=(evidence=MODEL)=>{const inputs=[];return {inputs,evidence,async decide(input){inputs.push(structuredClone(input));const p=Number(/p=(0\.\d+)/.exec(input.text)?.[1]??0);if(/explode/.test(input.text))throw new Error('occupant failure');return {labels:{spam:p},evidence:this.evidence};}};};
const fresh=async(t,options)=>{const w=await createWorld(options);t.after(()=>w.dispose());return w;};
const code=(r,status,error)=>{assert.equal(r.status,status,JSON.stringify(r.json));assert.equal(r.json.error,error);};
const say=(w,from,link,n,text)=>w.deliver(from,'bob',link,{operationId:uuidOf(n),body:encoder.encode(text),createdAt:w.clock.now()-1000});
const byState=async w=>Object.groupBy(await w.items('bob'),i=>i.state);

test('spam storm on a public link: tiers apply after custody and nothing observable varies with them',async t=>{
 const c=classifier(),w=await fresh(t,{classifier:c}),link=await w.link('bob',{public:true});
 await w.run('bob','intake.settings',{classifierConsent:true,pin:MODEL});
 const responses=[];
 for(let i=0;i<5;i++)responses.push(await say(w,'alice',link,i+1,`Win money p=0.99 ${i}`));
 responses.push(await say(w,'carol',link,10,'Maybe spam p=0.80'),await say(w,'carol',link,11,'Hello there p=0.10'));
 // Every admitted request got the same 200 {receipt} shape and headers, and each receipt verifies for its sender.
 for(const r of responses){assert.equal(r.status,200);assert.deepEqual(Object.keys(r.json),['receipt']);assert.deepEqual([...r.headers.keys()].sort(),[...responses[0].headers.keys()].sort());assert.equal((await w.verify('bob',r,r.json.receipt)).state,'delivered');}
 assert.deepEqual(Object.keys(responses[0].json.receipt.payload).sort(),Object.keys(responses[6].json.receipt.payload).sort());
 // The per-sender public limit (5/day) refuses before classification with the ordinary code.
 const over=await say(w,'alice',link,6,'p=0.10 legit?');code(over,429,'rate_limited');
 assert.equal((await w.run('bob','receive.items')).items.length,0,'requests wait for the drain');
 const drained=await w.system('bob','intake.drain',{});assert.deepEqual(drained,{processed:7,rejected:5,suspected:1,classified:7});
 const s=await byState(w);assert.equal(s.rejected.length,5);assert.equal(s.request.length,2);
 for(const item of s.rejected){assert.equal(item.notification,null);assert.ok(item.tags.some(x=>x.id==='sys:spam'&&x.rule==='default:reject.spam'));}
 const requests=await w.run('bob','intake.requests');assert.deepEqual(requests.map(r=>r.priority),['normal','low'],'suspected requests sort last');
 assert.equal(s.request.find(i=>i.priority==='low').notification,'quiet');assert.equal(s.request.find(i=>i.priority==='normal').notification,'push');
 assert.equal((await w.run('bob','intake.rejected')).length,5);
 // Replays after rejection still return the identical receipt.
 assert.deepEqual((await w.post('alice','bob',responses[0].request)).json,responses[0].json);
 // The classifier saw minimized text only: no principal, issuer, link capability, URL or recipient.
 for(const input of c.inputs){assert.deepEqual(Object.keys(input).sort(),['hints','text']);for(const leak of [P.alice.principal.subject,'provider.example','bindle_meta','hub.box.example'])assert.equal(input.text.includes(leak),false,leak);}
});

test('calibration mode, allowlist and rescue: thresholds are bound to the model version and allowlisted senders are never rejected',async t=>{
 const c=classifier(),w=await fresh(t,{classifier:c}),link=await w.link('bob',{public:true});
 await w.run('bob','intake.settings',{classifierConsent:true});
 await say(w,'alice',link,1,'p=0.995 unpinned');await w.system('bob','intake.drain',{});
 let [item]=await w.items('bob');assert.equal(item.state,'request');assert.equal(item.priority,'low');assert.equal(item.tagHistory[0].action,'calibration');
 // Pinned for version 3, then the occupant reports version 4: back to calibration, no auto-reject.
 await w.run('bob','intake.settings',{pin:MODEL});c.evidence={...MODEL,version:'4'};
 await say(w,'alice',link,2,'p=0.995 drifted');await w.system('bob','intake.drain',{});
 assert.equal((await byState(w)).rejected,undefined);
 // A published host calibration for exactly the reported version counts as a pin.
 // The occupant cannot calibrate itself, and a provider calibration must have sane thresholds (BB2-R5).
 c.calibration=()=>({...MODEL,version:'4',high:0.5,low:0.1});w.links.bob.calibration=evidence=>({...evidence,high:2,low:0.1});
 await say(w,'alice',link,7,'p=0.995 self-calibrated');await w.system('bob','intake.drain',{});assert.equal((await byState(w)).rejected,undefined);
 w.links.bob.calibration=evidence=>evidence?.version==='4'?{...MODEL,version:'4',high:0.99,low:0.8}:null;
 await say(w,'alice',link,3,'p=0.995 calibrated');await w.system('bob','intake.drain',{});
 const rejected=(await byState(w)).rejected;assert.equal(rejected.length,1);
 // Allowlisted principals: the reject is skipped and recorded; rules may still tag and deprioritize.
 await w.run('bob','intake.allow',{principal:P.carol.principal});
 await say(w,'carol',link,4,'p=0.999 from a friend');await w.system('bob','intake.drain',{});
 item=(await w.items('bob')).find(i=>i.author.principal.subject===P.carol.principal.subject);
 assert.equal(item.state,'request');assert.equal(item.priority,'low');assert.deepEqual(item.tagHistory.map(h=>[h.action,h.reason]),[['reject-skipped','allowlist']]);
 // Rescue with "always allow": the item becomes an ordinary request and later spam-scored mail is not rejected.
 assert.deepEqual(await w.run('bob','intake.rescue',{id:rejected[0].id,allow:true}),{id:rejected[0].id,state:'request'});
 await assert.rejects(w.run('bob','intake.rescue',{id:rejected[0].id}),{code:'not_found'});
 assert.equal((await w.run('bob','intake.rejected')).length,0);
 await say(w,'alice',link,5,'p=0.999 again');await w.system('bob','intake.drain',{});assert.equal((await byState(w)).rejected,undefined);
 // Known contacts and private links are not public requests at all.
 const priv=await w.link('bob');const r=await w.deliver('alice','bob',priv,{operationId:uuidOf(6),body:encoder.encode('p=0.999 private')});assert.equal(r.status,200);
 assert.equal((await w.items('bob')).find(i=>i.operationId===uuidOf(6)).state,'inbox');
});

test('without consent, occupant or allowance there is no auto-reject: heuristics only deprioritize',async t=>{
 const c=classifier(),w=await fresh(t,{classifier:c}),consumer=await bridgeConsumer();w.links.bob.state.consumers.set(consumer.origin,consumer);
 const deliver=async(over,tx)=>{w.clock.advance(2100);return w.intake('bob',{tx:tx??crypto.randomUUID(),contract:INTAKE_CONTRACT,consumer:consumer.origin,args:await consumer.args({recipient:P.bob.principal,receivedAt:w.clock.now()-1000,...over})});};
 assert.deepEqual(await deliver({text:'p=0.999',automation:['list-unsubscribe']}),{disposition:'stored-receipt'});
 await w.system('bob','intake.drain',{});assert.equal(c.inputs.length,0,'no consent: never called');
 let [item]=await w.items('bob');assert.equal(item.state,'request');assert.equal(item.tags[0].source,'heuristic');assert.equal(item.verifiedSender,false);
 await w.run('bob','intake.settings',{classifierConsent:true,pin:MODEL,allowance:1});
 await deliver({text:'p=0.999 first',from:'a@one.example'});await deliver({text:'p=0.999 second',from:'b@two.example',dmarc:'fail'});
 const out=await w.system('bob','intake.drain',{});assert.equal(out.classified,1);assert.equal(out.rejected,1);
 item=(await w.items('bob')).find(i=>i.asserted.address==='b@two.example');assert.equal(item.state,'request');assert.deepEqual(item.tags.map(x=>x.source),['heuristic'],'allowance exhausted: heuristic fallback');
 // A failing occupant falls back to heuristics too.
 await w.run('bob','intake.settings',{allowance:10});await deliver({text:'explode p=0.999',from:'c@three.example'});await w.system('bob','intake.drain',{});
 assert.equal((await w.items('bob')).find(i=>i.asserted.address==='c@three.example').state,'request');
 assert.equal(decideTier({result:null,hints:['dmarc-fail']}).tier,'suspect');assert.equal(decideTier({result:{spam:0.99,evidence:MODEL},pins:[{...MODEL,high:T_HIGH,low:0.7}]}).tier,'reject');
 assert.equal(decideTier({result:{spam:1.5,evidence:MODEL},pins:[{...MODEL,high:T_HIGH,low:0.7}]}).tier,'none','out-of-range scores are ignored');
});

test('bridged intake verifies provenance, deduplicates on jti and tx, and storms hit domain and owner limits',async t=>{
 const c=classifier(),w=await fresh(t,{classifier:c}),consumer=await bridgeConsumer(),forger=await bridgeConsumer();w.links.bob.state.consumers.set(consumer.origin,consumer);
 await w.run('bob','intake.settings',{classifierConsent:true,pin:MODEL,allowance:10000});
 const args=over=>consumer.args({recipient:P.bob.principal,receivedAt:w.clock.now()-1000,...over}),call=(a,tx=crypto.randomUUID(),origin=consumer.origin)=>{w.clock.advance(2100);return w.intake('bob',{tx,contract:INTAKE_CONTRACT,consumer:origin,args:a});};
 // 2.1 s between mails keeps the storm under the owner's per-minute receipt window, isolating the public limits.
 const a=await args({jti:'dup-1'}),tx=crypto.randomUUID();
 assert.deepEqual(await call(a,tx),{disposition:'stored-receipt'});assert.deepEqual(await call(a,tx),{disposition:'stored-receipt'});assert.deepEqual(await call(a),{disposition:'stored-receipt'});
 assert.equal((await w.items('bob')).length,1);
 await assert.rejects(call(await forger.args({recipient:P.bob.principal,receivedAt:w.clock.now()})),{code:'not_authorized'});
 await assert.rejects(call(await args({recipient:P.carol.principal})),{code:'not_authorized'});
 const tampered=await args({});tampered.message.parts[0].dataBase64url='AAAA';await assert.rejects(call(tampered),{code:'malformed'});
 await assert.rejects(call(await args({receivedAt:w.clock.now()-8*86400000})),{code:'envelope_expired'});
 // Same sender: 5 per day. Same domain: 50 per day. Owner: 200 public requests per day.
 for(let i=0;i<4;i++)await call(await args({from:'same@spam.example',text:`p=0.99 ${i}`}));
 await call(await args({from:'same@spam.example'}));await assert.rejects(call(await args({from:'same@spam.example'})),{code:'rate_limited'});
 let n=0;for(;n<60;n++){try{await call(await args({from:`u${n}@flood.example`,text:'p=0.99'}));}catch(error){assert.equal(error.code,'rate_limited');break;}}
 assert.equal(n,50);
 let total=(await w.items('bob')).length;for(let d=0;total<200;d++){await call(await args({from:`x${d}@d${d}.example`,text:'p=0.99'}));total++;}
 await assert.rejects(call(await args({from:'late@fresh.example'})),{code:'rate_limited'});
 assert.equal((await w.items('bob')).length,200);
});

test('the Rejected view is bounded to 500 items and 7 days, from its own reserve',async t=>{
 const c=classifier(),w=await fresh(t,{classifier:c}),consumer=await bridgeConsumer();w.links.bob.state.consumers.set(consumer.origin,consumer);
 await w.run('bob','intake.settings',{classifierConsent:true,pin:MODEL,allowance:10000});
 const legit=await consumer.args({recipient:P.bob.principal,receivedAt:w.clock.now()-1000,from:'friend@ok.example',text:'p=0.10 lunch?'});
 await w.intake('bob',{tx:crypto.randomUUID(),contract:INTAKE_CONTRACT,consumer:consumer.origin,args:legit});
 // 490 earlier rejections (seeded directly, a day old, for speed), then a 30-mail flood through intake and the drain.
 const seededAt=w.clock.now()-86400000;
 await w.peer('bob').store.transaction(async tx=>{for(let i=0;i<490;i++){const id=`seed${String(i).padStart(39,'0')}`;await tx.put(`item/${id}`,{id,origin:'channel',kind:'channel',asserted:{sender:{envelopeFrom:'x@y.example',headerFrom:'x@y.example'},dmarc:'none',automation:[],address:'x@y.example'},subject:'',state:'rejected',rejectedAt:seededAt+i,receivedAt:seededAt+i,tags:[],tagHistory:[],quarantined:false});await tx.put(`rejected/${String(seededAt+i).padStart(16,'0')}/${id}`,{id});}});
 for(let i=0;i<30;i++,w.clock.advance(2100))await w.intake('bob',{tx:crypto.randomUUID(),contract:INTAKE_CONTRACT,consumer:consumer.origin,args:await consumer.args({recipient:P.bob.principal,receivedAt:w.clock.now()-1000,from:`s${i}@d${i}.example`,text:'p=0.99'})});
 while((await w.system('bob','intake.drain',{limit:256})).processed);
 const rejected=await w.run('bob','intake.rejected');assert.equal(rejected.length,500);assert.ok(rejected[0].rejectedAt>=rejected.at(-1).rejectedAt);
 assert.equal(rejected.filter(r=>r.id.startsWith('seed')).length,470,'the 20 oldest were evicted and erased');assert.equal(await w.peer('bob').store.get(`item/seed${'0'.repeat(39)}`),undefined);
 assert.equal((await w.run('bob','intake.requests')).length,1,'the flood never evicted the legitimate request');
 w.clock.advance(7*86400000+1);await w.system('bob','intake.sweep',{});assert.equal((await w.run('bob','intake.rejected')).length,0);
 assert.equal((await w.items('bob')).length,1);
});

test('minimization redacts capabilities, URLs, tokens and codes and bounds the text',()=>{
 const out=minimize('See https://x.example/a?b=c and web+bindle://add-contact?x bindle_meta=aaa.bbb.ccc Bearer abc.def code 123456 key ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 p=0.42');
 for(const leak of ['https://','web+bindle','aaa.bbb.ccc','abc.def','123456','ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'])assert.equal(out.includes(leak),false,leak);
 assert.ok(out.includes('p=0.42'));assert.equal(minimize('x'.repeat(20000).replace(/x/g,'ab ')).length,8000);
});

test('a crash during the drain leaves the item pending and the rerun applies it exactly once; quarantine wins',async t=>{
 const c=classifier(),w=await fresh(t,{classifier:c}),link=await w.link('bob',{public:true});
 await w.run('bob','intake.settings',{classifierConsent:true,pin:MODEL});
 await say(w,'alice',link,1,'p=0.99 crash');
 const bob=w.peer('bob');bob.faults={mailboxStore:[{method:'transaction',when:1,mode:'throw'}]};await w.network.recover('bob');
 await assert.rejects(w.system('bob','intake.drain',{}),{code:'injected_fault'});assert.equal((await w.items('bob'))[0].state,'pending');
 assert.equal((await w.system('bob','intake.drain',{})).rejected,1);assert.equal((await w.system('bob','intake.drain',{})).processed,0);
 assert.equal((await w.items('bob'))[0].tags.filter(x=>x.id==='sys:spam').length,1);
 // A request whose author key is learned revoked before the drain is quarantined, never classified or shown.
 await say(w,'carol',link,2,'p=0.10 pending');w.directory.revoke(P.carol.jkt,Math.floor(w.clock.now()/3600000));
 w.clock.advance(300001);const recheck=await w.system('bob','delegation.recheck',{});assert.equal(recheck.revoked,1);
 const before=c.inputs.length;assert.equal((await w.system('bob','intake.drain',{})).processed,0);assert.equal(c.inputs.length,before);
 assert.equal((await w.items('bob')).find(i=>i.author.principal.subject===P.carol.principal.subject).quarantined.reason,'delegation_revoked');
});

test('review regressions: intake dedup binds consumer and digest, spoofed allowlisted addresses, the allowance reservation, user-body erasure',async t=>{
 const c=classifier(),deleted=[],storage={async put(){},async delete(key){deleted.push(key);}},w=await fresh(t,{classifier:c,userStorage:storage}),consumer=await bridgeConsumer();w.links.bob.state.consumers.set(consumer.origin,consumer);
 const args=over=>consumer.args({recipient:P.bob.principal,receivedAt:w.clock.now()-1000,...over}),call=(a,tx=crypto.randomUUID(),origin=consumer.origin)=>{w.clock.advance(2100);return w.intake('bob',{tx,contract:INTAKE_CONTRACT,consumer:origin,args:a});};
 // BB2-R4: a stored tx is never answered for another consumer or other content.
 const first=await args({jti:'r4'}),tx=crypto.randomUUID();await call(first,tx);
 await assert.rejects(call({message:{parts:[]},provenance:'x.y.z'},tx,'https://other.example'),{code:'malformed'});
 await assert.rejects(call(await args({jti:'r4-other'}),tx),{code:'operation_conflict'});
 await assert.rejects(call(await args({jti:'r4',text:'different'})),{code:'operation_conflict'});
 assert.equal((await w.items('bob')).length,1);
 // BB2-R6: an allowlisted address with failing DMARC is not protected from auto-reject.
 await w.run('bob','intake.settings',{classifierConsent:true,pin:MODEL,allowance:1000});await w.run('bob','intake.allow',{email:'boss@corp.example'});
 await call(await args({from:'boss@corp.example',dmarc:'fail',text:'p=0.99 spoof'}));await call(await args({from:'boss@corp.example',text:'p=0.99 real'}));
 await w.system('bob','intake.drain',{});const boss=(await w.items('bob')).filter(i=>i.asserted?.address==='boss@corp.example');
 assert.deepEqual(boss.map(i=>[i.asserted.dmarc,i.state]).sort(),[['fail','rejected'],['pass','request']]);
 // BB2-R8: concurrent drains reserve calls inside a transaction and never overspend.
 await w.run('bob','intake.settings',{allowance:c.inputs.length+1});for(let i=0;i<3;i++)await call(await args({from:`a${i}@x${i}.example`,text:'p=0.10'}));
 const before=c.inputs.length;await Promise.all([w.system('bob','intake.drain',{}),w.system('bob','intake.drain',{}),w.system('bob','intake.drain',{})]);assert.equal(c.inputs.length-before,1);
 // BB2-R7: erasing a rejected item with a user-storage body queues the object; the sweep deletes it.
 const store=w.peer('bob').store,id='u'.repeat(43);await store.transaction(async tx=>{await tx.put(`item/${id}`,{id,origin:'native',author:{jkt:'j1',principal:P.alice.principal},state:'rejected',rejectedAt:1,bodyRef:{storage:'user',key:'bindlebox/v1/items/u/1'},tags:[],tagHistory:[]});await tx.put(`rejected/${'1'.padStart(16,'0')}/${id}`,{id});await tx.put(`by-jkt/j1/${id}`,1);});
 assert.deepEqual(await w.system('bob','intake.sweep',{}),{deleted:1,pending:0});assert.deepEqual(deleted,['bindlebox/v1/items/u/1']);assert.equal(await store.get(`by-jkt/j1/${id}`),undefined);
});

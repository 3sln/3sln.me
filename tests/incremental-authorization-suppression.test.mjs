// IA-2 engine-level suite: suppression invisible to the app (same response shape, dwell class and counters as a
// decline), every scope with sibling clients and version churn, matching items only, the decline ladder counting only
// real decisions, caps, nagging through varied request shapes, owner undo, export and erasure.
import test from 'node:test';
import assert from 'node:assert/strict';
import {IncrementalAdmit,IncrementalBegin,IncrementalDecide,IncrementalAbandon,IncrementalExchange} from '../packages/federation/incremental.mjs';
import {SuppressionList,SuppressionAdd,SuppressionRemove,SuppressionExport,SuppressionErase,RequestOwnerActed,suppresses,appSite} from '../packages/federation/suppression.mjs';
import {fixture,engine,grantMoreInput,configureInput,calRequest,tasks,tasksMobile,stranger,subject,owner,CAL,CAL2,SUMMARY,SUMMARY2,CALENDAR,MAIL,MAILPREF,registrableDomain} from './incremental-authorization-helpers.mjs';

const run=(e,Kind,input)=>e.perform(new Kind({input}));
const asOwner=(e,Kind,input={})=>Kind.prototype.fetch?e.read(new Kind({input,actor:{kind:'owner',owner}})):e.perform(new Kind({input,actor:{kind:'owner',owner}}));
const HOUR=3600000,DAY=24*HOUR;
async function open(e,f,admitted){await run(e,IncrementalAdmit,admitted.input);return run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});}
const decide=(e,admitted,decision)=>run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision});
const exchange=(e,admitted,code)=>run(e,IncrementalExchange,{clientId:admitted.input.clientId,code,redirectUri:admitted.input.binding.redirectUri,codeVerifier:admitted.verifier});
const rateLimited=async(e,admitted)=>{try{await run(e,IncrementalAdmit,admitted.input);return null;}catch(error){assert.equal(error.code,'rate_limited');return {retryAfter:error.retryAfter,ownerReviewUri:error.ownerReviewUri};}};
function setup(f){f.p.grant(tasks.id,CAL,{fields:['color'],methods:{}});f.p.newest.set(`${subject}|${tasks.id}`,{expiresAt:null,authTime:1});}

test('suppression is invisible: creation, dwell, completion, outcome and counters match an ordinary decline',async t=>{
 const traces={};
 for(const path of ['decline','suppressed']){
  const f=fixture();setup(f);const e=await engine(t,f);
  if(path==='suppressed')await asOwner(e,SuppressionAdd,{clientId:tasks.id,scope:'fragment',fragment:CAL});
  // Creation never consults suppression records.
  const lists=[];const transaction=f.store.transaction.bind(f.store);f.store.transaction=fn=>transaction(tx=>fn({...tx,list:prefix=>{lists.push(prefix);return tx.list(prefix);}}));
  const admitted=grantMoreInput([calRequest()]),created=await run(e,IncrementalAdmit,admitted.input);f.store.transaction=transaction;
  assert(!lists.some(prefix=>prefix.startsWith('incremental/s/')),'admit read suppression records');
  const {view}=await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});assert.equal(view.blocked,path==='suppressed');
  const decision=path==='suppressed'?{notice:'return'}:{denied:true};
  const early=await decide(e,admitted,decision).then(()=>null,error=>error.code);f.time.advance(1500);
  const completion=await decide(e,admitted,decision),response=await exchange(e,admitted,completion.code);
  traces[path]={created,early,completionKeys:Object.keys(completion),response,next:await rateLimited(e,grantMoreInput([calRequest()]))};
 }
 assert.deepEqual(traces.suppressed,traces.decline);assert.deepEqual(traces.decline.created,{admitted:true});assert.equal(traces.decline.early,'decision_not_armed');
 assert.deepEqual(traces.decline.response,{fragment_outcomes:[{fragment:CAL,outcome:'declined'}]});assert.equal(traces.decline.next.retryAfter,24*3600,'both paths start the same 24 h cooldown');
});

test('a suppressed configure returns unchanged exactly like a declined one, and the notice exists only when everything is blocked',async t=>{
 const f=fixture();f.p.grant(tasks.id,SUMMARY,{fields:['day','enabled'],methods:{}});const e=await engine(t,f);
 await asOwner(e,SuppressionAdd,{clientId:tasks.id,scope:'field',fragment:SUMMARY,field:'day'});
 const partly=configureInput({fragment:SUMMARY},{values:{day:'monday',enabled:true}}),{view}=await open(e,f,partly);
 assert.equal(view.blocked,false);assert.deepEqual(view.fields.map(x=>[x.name,x.suppressed,Object.hasOwn(x,'suggested')]),[['day',true,false],['enabled',false,true]],'matching items only; a suppressed field shows no suggestion');
 f.time.advance(1500);await assert.rejects(decide(e,partly,{notice:'return'}),{code:'invalid_args'});
 await assert.rejects(decide(e,partly,{changes:[{field:'day',value:'monday'}]}),{code:'invalid_args'},'a pre-declined field needs an explicit reveal');
 assert.deepEqual(await decide(e,partly,{changes:[{field:'enabled',take:'suggested',via:'field'}]}),{result:'configured'});
 const blocked=configureInput({fragment:SUMMARY,fields:['day']});f.time.advance(DAY);const second=await open(e,f,blocked);assert.equal(second.view.blocked,true);f.time.advance(1500);
 assert.deepEqual(await decide(e,blocked,{notice:'return'}),{result:'unchanged'});
});

test('scopes: app, kind, fragment (own-host churn and supersedes chains) and field; sibling clients share them',async t=>{
 const item=(over={})=>({kind:'grant-more',chain:[CAL],host:'cal.example',own:false,...over});
 assert(suppresses({scope:'app'},item({kind:'configure'})));assert(suppresses({scope:'kind',kind:'grant-more'},item()));assert(!suppresses({scope:'kind',kind:'configure'},item()));
 assert(suppresses({scope:'fragment',fragment:CAL},item({chain:[CAL2,CAL]})),'a new version that supersedes the blocked one');assert(!suppresses({scope:'fragment',fragment:CAL2},item()),'an older version is not blocked by a newer one');
 assert(suppresses({scope:'fragment',fragment:SUMMARY,host:'tasks.example'},item({chain:[SUMMARY2],host:'tasks.example',own:true})),'own-host /v2 churn');
 assert(!suppresses({scope:'fragment',fragment:CAL,kind:'configure'},item()));assert(suppresses({scope:'field',fragment:SUMMARY,field:'day',host:'tasks.example'},{kind:'configure',chain:[SUMMARY2],host:'tasks.example',field:'day'}));
 assert.equal(appSite(tasksMobile,registrableDomain),appSite(tasks,registrableDomain));assert.throws(()=>appSite({origin:'https://x.invalid'},()=>undefined),{code:'temporarily_unavailable'});
 const f=fixture();f.p.grant(tasksMobile.id,SUMMARY2,{fields:['day'],methods:{}});const e=await engine(t,f);
 await asOwner(e,SuppressionAdd,{clientId:tasks.id,scope:'fragment',fragment:SUMMARY,kind:'configure'});
 const sibling=configureInput({fragment:SUMMARY2},{values:{day:'monday'}},{client:tasksMobile}),{view}=await open(e,f,sibling);assert.equal(view.blocked,true,'the mobile client asking about v2 on the same host is blocked');
 const listed=await asOwner(e,SuppressionList,{clientId:tasksMobile.id});assert.equal(listed.length,1);assert.equal(listed[0].host,'tasks.example');assert.equal(listed[0].site,'tasks.example');
});

test('matching items only: unrelated items are presented; answering a pre-declined item needs reveal and lifts the block',async t=>{
 const f=fixture();setup(f);f.p.grant(tasks.id,SUMMARY,{fields:['day'],methods:{}});const e=await engine(t,f);
 await asOwner(e,SuppressionAdd,{clientId:tasks.id,scope:'fragment',fragment:CAL});
 const admitted=grantMoreInput([calRequest(),{fragment:SUMMARY,purpose:'Weekly summary',fields:['day','enabled'],methods:{}}]),{view}=await open(e,f,admitted);
 assert.deepEqual(view.requests.map(r=>[r.fragment,r.suppressed]),[[CAL,true],[SUMMARY,false]]);assert.equal(view.blocked,false);f.time.advance(1500);
 await assert.rejects(decide(e,admitted,{approved:[{fragment:CAL,fields:['calendar']}]}),{code:'invalid_args'});
 const {code}=await decide(e,admitted,{approved:[{fragment:SUMMARY,fields:['enabled']},{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}],reveal:true});
 assert.deepEqual((await exchange(e,admitted,code)).fragment_outcomes.map(o=>o.outcome),['granted','granted']);assert.deepEqual(await asOwner(e,SuppressionList,{clientId:tasks.id}),[],'revealing and answering removes the matching suppression');
});

test('the ladder counts only real decisions: abandon, expiry, supersession and blocked pages advance caps only',async t=>{
 const f=fixture();setup(f);const e=await engine(t,f);
 // Abandoned (page cancel), superseded and expired entries leave no cooldown.
 const a=grantMoreInput([calRequest()]);await open(e,f,a);await run(e,IncrementalAbandon,{entryHash:a.input.entryHash});
 const b=grantMoreInput([calRequest()]);await open(e,f,b);const c=grantMoreInput([calRequest()]);await run(e,IncrementalAdmit,c.input);
 assert.deepEqual(await run(e,IncrementalBegin,{entryHash:b.input.entryHash,subject}),{view:{superseded:true}});
 f.time.advance(HOUR);const d=grantMoreInput([calRequest()]);await open(e,f,d);f.time.advance(11*60000);
 await assert.rejects(decide(e,d,{denied:true}),{code:'invalid_request'},'expired');
 f.time.advance(HOUR);assert.equal(await rateLimited(e,grantMoreInput([calRequest()])),null,'no cooldown from abandon, supersession or expiry');
});

test('decline ladder: 24 h, 7 d, then 30 d per target; approvals start none; 90 quiet days or an owner grant reset it',async t=>{
 const f=fixture({limits:{requests:{hour:100,day:100,month:100}}});setup(f);const e=await engine(t,f);
 const declineOnce=async()=>{const x=grantMoreInput([calRequest()]);await open(e,f,x);f.time.advance(1500);await decide(e,x,{denied:true});};
 await declineOnce();assert.equal((await rateLimited(e,grantMoreInput([calRequest()]))).retryAfter,DAY/1000);
 f.time.advance(DAY);await declineOnce();assert.equal((await rateLimited(e,grantMoreInput([calRequest()]))).retryAfter,7*DAY/1000);
 f.time.advance(7*DAY);await declineOnce();assert.equal((await rateLimited(e,grantMoreInput([calRequest()]))).retryAfter,30*DAY/1000);
 f.time.advance(30*DAY);await declineOnce();const fourth=await rateLimited(e,grantMoreInput([calRequest()]));assert.equal(fourth.retryAfter,30*DAY/1000);assert.equal(fourth.ownerReviewUri,'https://provider.example/access/apps');
 // Another fragment is a separate target; the cooldown never blocks unrelated requests.
 f.p.grant(tasks.id,SUMMARY,{fields:['day'],methods:{}});assert.equal(await rateLimited(e,grantMoreInput([{fragment:SUMMARY,purpose:'x',fields:['enabled'],methods:{}}])),null);
 // The owner granting the target themselves resets its ladder.
 await asOwner(e,RequestOwnerActed,{clientId:tasks.id,kind:'grant-more',fragment:CAL});assert.equal(await rateLimited(e,grantMoreInput([calRequest()])),null);
 const g=fixture({limits:{requests:{hour:100,day:100,month:100}}});setup(g);const e2=await engine(t,g);
 for(const days of [0,1,7]){g.time.advance(days*DAY);const x=grantMoreInput([calRequest()]);await open(e2,g,x);g.time.advance(1500);await decide(e2,x,{denied:true});}
 g.time.advance(90*DAY);const after=grantMoreInput([calRequest()]);await open(e2,g,after);g.time.advance(1500);await decide(e2,after,{denied:true});
 assert.equal((await rateLimited(e2,grantMoreInput([calRequest()]))).retryAfter,DAY/1000,'90 days without a decline restart the ladder at 24 h');
 const h=fixture({limits:{requests:{hour:100,day:100,month:100}}});setup(h);const e3=await engine(t,h);const ok=grantMoreInput([calRequest()]);await open(e3,h,ok);h.time.advance(1500);await decide(e3,ok,{approved:[{fragment:CAL,fields:['calendar']}]});
 assert.equal(await rateLimited(e3,grantMoreInput([calRequest({fields:['week'],methods:{}})])),null,'an approved request starts no cooldown');
});

test('caps: 3 per hour, 6 per day and 20 per 30 days across both kinds and sibling clients',async t=>{
 const f=fixture();setup(f);f.p.grant(tasks.id,SUMMARY,{fields:['day'],methods:{}});f.p.grant(tasksMobile.id,SUMMARY,{fields:['day'],methods:{}});const e=await engine(t,f);
 const shapes=[()=>grantMoreInput([calRequest()]),()=>configureInput({fragment:SUMMARY}),()=>configureInput({fragment:SUMMARY},undefined,{client:tasksMobile})];
 for(const make of shapes)await run(e,IncrementalAdmit,make().input);
 const limited=await rateLimited(e,grantMoreInput([calRequest()],{client:tasksMobile}));assert(limited&&limited.retryAfter<=3600);
 f.time.advance(HOUR);for(const make of shapes)await run(e,IncrementalAdmit,make().input);f.time.advance(HOUR);assert((await rateLimited(e,shapes[0]())).retryAfter>HOUR/1000,'6 per day');
 const g=fixture();setup(g);const e2=await engine(t,g);let admitted=0;for(let day=0;day<40;day++){for(let n=0;n<6;n++){try{await run(e2,IncrementalAdmit,grantMoreInput([calRequest({fields:['week'],methods:{}})]).input);admitted++;}catch(error){assert.equal(error.code,'rate_limited');}g.time.advance(HOUR);}g.time.advance(18*HOUR);if(day===29)assert.equal(admitted,20,'20 per 30 days');}
 assert.equal(await rateLimited(e2,grantMoreInput([calRequest()],{client:stranger})),null,'another app has its own caps');
});

test('nagging via varied shapes stays bounded: field subsets, own-host versions and the mobile sibling share the cooldown',async t=>{
 const f=fixture({limits:{requests:{hour:100,day:100,month:100}}});f.p.grant(tasks.id,SUMMARY,{fields:['day','enabled'],methods:{}});f.p.grant(tasks.id,SUMMARY2,{fields:['day'],methods:{}});f.p.grant(tasksMobile.id,SUMMARY,{fields:['day','enabled'],methods:{}});const e=await engine(t,f);
 const first=configureInput({fragment:SUMMARY,fields:['day']});await open(e,f,first);f.time.advance(1500);await decide(e,first,{denied:true});
 for(const shape of [configureInput({fragment:SUMMARY}),configureInput({fragment:SUMMARY,fields:['enabled','day']}),configureInput({fragment:SUMMARY2}),configureInput({fragment:SUMMARY,fields:['day']},undefined,{client:tasksMobile})])assert(await rateLimited(e,shape),JSON.stringify(shape.input.target));
 assert.equal(await rateLimited(e,configureInput({fragment:SUMMARY,fields:['enabled']})),null,'a different field is a different target (spec §10)');
 const g=fixture({limits:{requests:{hour:100,day:100,month:100}}});g.p.grant(tasks.id,SUMMARY,{fields:['day'],methods:{}});const e2=await engine(t,g);
 const own=grantMoreInput([{fragment:SUMMARY,purpose:'x',fields:['enabled'],methods:{}}]);await open(e2,g,own);g.time.advance(1500);await decide(e2,own,{denied:true});
 assert(await rateLimited(e2,grantMoreInput([{fragment:SUMMARY2,purpose:'x',fields:['day'],methods:{}}])),'an own-host /v2 shares the v1 cooldown');
});

test('owner undo, export and erasure; removal never replays a request',async t=>{
 const f=fixture();setup(f);const e=await engine(t,f);
 const added=await asOwner(e,SuppressionAdd,{clientId:tasks.id,scope:'kind',kind:'grant-more'});assert.equal((await asOwner(e,SuppressionAdd,{clientId:tasksMobile.id,scope:'kind',kind:'grant-more'})).id,added.id,'idempotent per app site');
 for(const input of [{clientId:tasks.id,scope:'kind'},{clientId:tasks.id,scope:'field',fragment:SUMMARY},{clientId:tasks.id,scope:'fragment',fragment:'http://x.example/'},{clientId:tasks.id,scope:'app',kind:'configure'},{clientId:'https://unknown.example/c',scope:'app'},{clientId:tasks.id,scope:'everything'}])await assert.rejects(asOwner(e,SuppressionAdd,input),{code:'invalid_args'},JSON.stringify(input));
 const x=grantMoreInput([calRequest()]);const {view}=await open(e,f,x);assert.equal(view.blocked,true);
 assert.deepEqual(await asOwner(e,SuppressionRemove,{clientId:tasks.id,id:added.id}),{removed:true});assert.deepEqual(await asOwner(e,SuppressionList,{}),[]);
 assert.equal(f.p.calls.commit+f.p.calls.issue,0,'removing a suppression replays nothing');
 await asOwner(e,SuppressionAdd,{clientId:tasks.id,scope:'app'});const exported=await asOwner(e,SuppressionExport);assert.equal(exported.suppressions.length,1);assert.equal(exported.suppressions[0].scope,'app');
 assert(((await asOwner(e,SuppressionErase)).removed)>=2);assert.deepEqual((await asOwner(e,SuppressionExport)).suppressions,[]);
 await assert.rejects(e.read(new SuppressionList({input:{},actor:{kind:'app'}})),{code:'unauthorized'});
});

test('the app-wide option is offered after 3 declines from one app in 7 days',async t=>{
 const f=fixture({limits:{requests:{hour:100,day:100,month:100}}});setup(f);f.p.grant(tasks.id,SUMMARY,{fields:['day','enabled'],methods:{}});const e=await engine(t,f);
 const shapes=[()=>grantMoreInput([calRequest()]),()=>configureInput({fragment:SUMMARY,fields:['day']}),()=>configureInput({fragment:SUMMARY,fields:['enabled']}),()=>grantMoreInput([{fragment:SUMMARY2,purpose:'x',fields:['day'],methods:{}}],{client:tasksMobile})];
 const offers=[];for(const make of shapes){const x=make();const {view}=await open(e,f,x);offers.push(view.offerAppScope);f.time.advance(1500);await decide(e,x,{denied:true});}
 assert.deepEqual(offers,[false,false,false,true]);
});

test('review fixes: superseded pages need the dwell and still count a real decline; reveal lifts only the item block',async t=>{
 const f=fixture({limits:{requests:{hour:100,day:100,month:100}}});setup(f);const e=await engine(t,f);
 const a=grantMoreInput([calRequest()]);await open(e,f,a);const b=grantMoreInput([calRequest({fields:['week'],methods:{}})]);await run(e,IncrementalAdmit,b.input);
 // IA-R4: no zero-dwell suppression on a superseded page.
 const fresh=grantMoreInput([calRequest({fields:['week'],methods:{}})]);await run(e,IncrementalAdmit,fresh.input);assert.deepEqual(await run(e,IncrementalBegin,{entryHash:b.input.entryHash,subject}),{view:{superseded:true}});
 await assert.rejects(decide(e,b,{denied:true,suppress:{scope:'app'}}),{code:'decision_not_armed'});
 // IA-R5: the owner's decline on the page the app superseded still steps the ladder.
 f.time.advance(1500);const old=await decide(e,a,{denied:true});assert.deepEqual((await exchange(e,a,old.code)).fragment_outcomes,[{fragment:CAL,outcome:'declined'}]);
 assert(await rateLimited(e,grantMoreInput([calRequest()])),'superseding on purpose does not erase a decline');
 // IA-R3: revealing one item never removes an app-wide block.
 const g=fixture();setup(g);const e2=await engine(t,g);await asOwner(e2,SuppressionAdd,{clientId:tasks.id,scope:'app'});await asOwner(e2,SuppressionAdd,{clientId:tasks.id,scope:'fragment',fragment:CAL});
 const x=grantMoreInput([calRequest()]);await open(e2,g,x);g.time.advance(1500);await decide(e2,x,{approved:[{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}],reveal:true});
 assert.deepEqual((await asOwner(e2,SuppressionList,{clientId:tasks.id})).map(r=>r.scope),['app']);
});

test('review fixes: a configure save resets only the fields it changed (IA-R6)',async t=>{
 const f=fixture({limits:{requests:{hour:100,day:100,month:100}}});f.p.grant(tasks.id,SUMMARY,{fields:['day','label'],methods:{}});f.p.prefs.set(`${subject}|${SUMMARY}`,{revision:'r0',values:{day:'friday'}});const e=await engine(t,f);
 for(const wait of [0,DAY]){f.time.advance(wait);const x=configureInput({fragment:SUMMARY,fields:['day']});await open(e,f,x);f.time.advance(1500);await decide(e,x,{denied:true});}
 f.time.advance(7*DAY);const both=configureInput({fragment:SUMMARY,fields:['day','label']});await open(e,f,both);f.time.advance(1500);assert.deepEqual(await decide(e,both,{changes:[{field:'label',value:'mine'}]}),{result:'configured'});
 const third=configureInput({fragment:SUMMARY,fields:['day']});await open(e,f,third);f.time.advance(1500);await decide(e,third,{denied:true});
 assert.equal((await rateLimited(e,configureInput({fragment:SUMMARY,fields:['day']}))).retryAfter,30*DAY/1000,'the declined field keeps its ladder (third decline → 30 d)');
});

test('IA-R2: login deltas from sibling or changed metadata clients share the site counters; unreviewed tier-4 additions are pre-declined',async t=>{
 const f=fixture({limits:{requests:{hour:100,day:100,month:100}}});setup(f);const e=await engine(t,f);
 const delta=(client,requests,hash=b())=>f.incremental.loginDelta({entryHash:hash,subject,clientId:client.id,client,requests});
 let n=0;const b=()=>`${'L'.repeat(42)}${'ABCDEFGHIJKLMNOP'[n++]}`;
 const x=grantMoreInput([calRequest()]);await open(e,f,x);f.time.advance(1500);await decide(e,x,{denied:true});
 const changed={...tasksMobile,name:'Renamed in metadata',redirectUris:['https://m.tasks.example/other']};f.p.connect(changed.id);
 const answer=await delta(changed,[{fragment:CAL,required:true,purpose:'x',fields:['calendar'],methods:{}}]);assert.deepEqual(answer.predeclined,[CAL]);assert.deepEqual(answer.requests,[]);
 f.p.grant(stranger.id,MAILPREF,{fields:['outbox'],methods:{outbox:{[MAIL]:['list']}}});
 const unreviewed=await delta(stranger,[{fragment:MAILPREF,required:true,purpose:'x',fields:['outbox'],methods:{outbox:{[MAIL]:['list','send']}}}]);
 assert.deepEqual(unreviewed.requests,[{fragment:MAILPREF,required:false,purpose:'x',fields:['outbox'],methods:{outbox:{[MAIL]:['list']}}}]);assert.deepEqual(unreviewed.predeclined,[MAILPREF]);
 assert.deepEqual(await f.incremental.loginDelta({entryHash:b(),subject,clientId:'https://new.example/c',client:{id:'https://new.example/c',origin:'https://new.example'},requests:[{fragment:CAL,required:true,purpose:'x',fields:['calendar']}]}),{first:true},'a first connection is unchanged');
});

test('IA-R2 re-review: fresh sibling IDs are not first connections; suppressed login items step the ladder; only the deciding account counts',async t=>{
 const f=fixture({limits:{requests:{hour:100,day:100,month:100}}});setup(f);const e=await engine(t,f);let n=0;const h=()=>`${'M'.repeat(42)}${'ABCDEFGHIJKLMNOP'[n++]}`;
 await asOwner(e,SuppressionAdd,{clientId:tasks.id,scope:'app'});
 const fresh={id:'https://tasks.example/client-2',name:'Tasks 2',origin:'https://tasks.example'};
 const answer=await f.incremental.loginDelta({entryHash:h(),subject,clientId:fresh.id,client:fresh,requests:[{fragment:CAL,required:true,purpose:'x',fields:['calendar'],methods:{}}]});
 assert.equal(answer.first,false,'IA-R2a');assert.deepEqual(answer.requests,[]);
 // IA-R2b: an armed decline of a login whose addition was suppressed steps the ladder like any decline.
 const g=fixture({limits:{requests:{hour:100,day:100,month:100}}});setup(g);const e2=await engine(t,g);await asOwner(e2,SuppressionAdd,{clientId:tasks.id,scope:'fragment',fragment:CAL});
 const hash=h();await g.incremental.loginDelta({entryHash:hash,subject,clientId:tasks.id,client:tasks,requests:[{fragment:CAL,required:true,purpose:'x',fields:['calendar'],methods:{}}]});g.time.advance(1500);
 assert.deepEqual(await g.incremental.loginOutcome({entryHash:hash,subject,approved:null}),{counted:1});
 await asOwner(e2,SuppressionRemove,{clientId:tasks.id,id:(await asOwner(e2,SuppressionList,{clientId:tasks.id}))[0].id});assert(await rateLimited(e2,grantMoreInput([calRequest()])),'the suppressed decline cooled the target, as a plain decline does');
 // IA-R2c: two accounts selected; an ownerless cancel counts for neither, an owner decision only for that owner.
 const k=fixture({limits:{requests:{hour:100,day:100,month:100}}});setup(k);const two=h(),other=`https://provider.example/entities/1c6a3b63-6c9f-4a4f-8b62-1d2e3f4a5b6c`;k.p.connect(tasks.id,other);
 for(const sub of [subject,other])await k.incremental.loginDelta({entryHash:two,subject:sub,clientId:tasks.id,client:tasks,requests:[calRequest({required:true})]});k.time.advance(1500);
 assert.deepEqual(await k.incremental.loginOutcome({entryHash:two,approved:null}),{counted:0});assert.deepEqual(await k.incremental.loginOutcome({entryHash:two,subject:other,approved:null}),{counted:1});
});

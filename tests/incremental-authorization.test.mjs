// IA-1 engine-level suite: every intent through its result states, token issuance only for added access, the
// configure/suggestion rules, entry validation, the unreviewed tier-4 refusal, self-nomination and the flag gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {IncrementalAdmit,IncrementalBegin,IncrementalDecide,IncrementalAbandon,IncrementalExchange,INCREMENTAL_OPERATIONS,incrementalMembers,grantDelta,fragmentOutcome,occupantCandidates,fieldSensitivity} from '../packages/federation/incremental.mjs';
import {fixture,engine,grantMoreInput,configureInput,calRequest,tasks,stranger,subject,CAL,CAL2,SUMMARY,MAILPREF,CALENDAR,MAIL,registrableDomain} from './incremental-authorization-helpers.mjs';

const run=(e,Kind,input)=>e.perform(new Kind({input}));
async function flow(t,f,admitted,decision,{arm=true}={}){
 const e=await engine(t,f);await run(e,IncrementalAdmit,admitted.input);const begun=await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});
 if(begun.complete)return {e,begun,completion:begun.complete};if(arm)f.time.advance(1500);
 return {e,begun,completion:await run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision})};
}
const exchange=(e,admitted,code,extra={})=>run(e,IncrementalExchange,{clientId:admitted.input.clientId,code,redirectUri:admitted.input.binding.redirectUri,codeVerifier:admitted.verifier,...extra});
function withCalendar(f){f.p.grant(tasks.id,CAL,{fields:['color'],methods:{}});f.p.newest.set(`${subject}|${tasks.id}`,{expiresAt:Date.UTC(2026,10,1),authTime:Date.UTC(2026,9,19)});}

test('grant-more: granted lists the complete current grant and issues a session capped by the newest one',async t=>{
 const f=fixture();withCalendar(f);const admitted=grantMoreInput([calRequest()]);
 const {e,begun,completion}=await flow(t,f,admitted,{approved:[{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}]});
 assert.deepEqual(begun.view.requests[0].delta,{fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}});assert.deepEqual(begun.view.requests[0].alreadyAllowed,{fields:['color'],methods:{}});
 assert.match(completion.code,/^ia1\./);const tokens=await exchange(e,admitted,completion.code);
 assert.deepEqual(tokens.fragment_outcomes,[{fragment:CAL,outcome:'granted',granted:{fields:['calendar','color'],methods:{calendar:{[CALENDAR]:['createEvent']}}}}]);
 assert.equal(tokens.access_token,'at-1');assert(!Object.hasOwn(tokens,'family'),'the internal family id never reaches the app');
 assert.deepEqual(f.p.calls.lastIssue,{subject,clientId:tasks.id,dpopJkt:undefined,notAfter:Date.UTC(2026,10,1),authTime:Date.UTC(2026,9,19)});
 await assert.rejects(exchange(e,admitted,completion.code),{code:'invalid_grant'});assert.deepEqual(f.p.calls.revoke,[{subject,clientId:tasks.id,family:'family-1'}],'a replayed code revokes what it issued');
});

test('grant-more: partial carries the full current grant; declined carries none and no tokens',async t=>{
 const f=fixture();withCalendar(f);const both=calRequest({fields:['calendar','week'],methods:{calendar:{[CALENDAR]:['createEvent','readEvents']}}}),admitted=grantMoreInput([both]);
 const {e,completion}=await flow(t,f,admitted,{approved:[{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['readEvents']}}}]});
 const partial=await exchange(e,admitted,completion.code);
 assert.deepEqual(partial.fragment_outcomes,[{fragment:CAL,outcome:'partial',granted:{fields:['calendar','color'],methods:{calendar:{[CALENDAR]:['readEvents']}}}}]);assert(partial.access_token,'partial adds access, so a session is issued');
 const g=fixture();withCalendar(g);const second=grantMoreInput([calRequest()]),declined=await flow(t,g,second,{denied:true});
 const response=await exchange(declined.e,second,declined.completion.code);assert.deepEqual(response,{fragment_outcomes:[{fragment:CAL,outcome:'declined'}]});assert.equal(g.p.calls.issue,0);assert.equal(g.p.calls.commit,0);
 assert.deepEqual(g.p.grants.get(`${subject}|${tasks.id}|${CAL}`),{fields:['color'],methods:{}},'declining never revokes existing access');
});

test('grant-more: no delta completes without a page, every outcome granted and no tokens; unknown fragments are unsupported',async t=>{
 const f=fixture();f.p.grant(tasks.id,CAL,{fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}});f.p.newest.set(`${subject}|${tasks.id}`,{expiresAt:null,authTime:1});
 const admitted=grantMoreInput([calRequest(),{fragment:'https://cal.example/preferences/unknown/v1',purpose:'x',fields:['a'],methods:{}}]),{e,begun}=await flow(t,f,admitted);
 assert(begun.complete&&!begun.view);const response=await exchange(e,admitted,begun.complete.code);
 assert.deepEqual(response.fragment_outcomes.map(o=>o.outcome),['granted','unsupported']);assert(!response.access_token&&!response.refresh_token);assert.equal(f.p.calls.issue,0);
});

test('tokens are never issued when the authoritative commit changed nothing, or without a live session to cap them',async t=>{
 const f=fixture();withCalendar(f);const admitted=grantMoreInput([calRequest()]),e=await engine(t,f);await run(e,IncrementalAdmit,admitted.input);await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});
 // The same access was committed concurrently: the port reads `before` in its own transaction and reports no change.
 const commit=f.p.grantsPort.commit;f.p.grantsPort.commit=async input=>{const out=await commit(input);for(const r of out.results)r.before=structuredClone(r.after);return out;};
 f.time.advance(1500);const {code}=await run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision:{approved:[{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}]}});
 const response=await exchange(e,admitted,code);assert.equal(f.p.calls.commit,1);assert.equal(response.fragment_outcomes[0].outcome,'granted');assert(!response.access_token);assert.equal(f.p.calls.issue,0);
 const g=fixture();g.p.grant(tasks.id,CAL,{fields:['color'],methods:{}});const second=grantMoreInput([calRequest()]),{e:e2,completion}=await flow(t,g,second,{approved:[{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['createEvent']}}}]});
 const unbounded=await exchange(e2,second,completion.code);assert.equal(unbounded.fragment_outcomes[0].outcome,'granted');assert(!unbounded.access_token,'no live session: outcomes only');
});

test('exchange binds client, callback, PKCE and the pinned DPoP key',async t=>{
 const f=fixture();withCalendar(f);const jkt='a'.repeat(43),admitted=grantMoreInput([calRequest()],{dpopJkt:jkt});
 const {e,completion}=await flow(t,f,admitted,{approved:[{fragment:CAL,fields:['calendar']}]});
 for(const extra of [{clientId:'https://other.example/client'},{redirectUri:'https://tasks.example/other'},{codeVerifier:'x'.repeat(43)},{dpopJkt:'b'.repeat(43)},{}])await assert.rejects(exchange(e,admitted,completion.code,{dpopJkt:jkt,...extra,...extra.dpopJkt===undefined&&Object.keys(extra).length===0?{dpopJkt:undefined}:{}}),{code:'invalid_grant'});
 const tokens=await exchange(e,admitted,completion.code,{dpopJkt:jkt});assert.equal(tokens.token_type,'DPoP');assert.equal(f.p.calls.lastIssue.dpopJkt,jkt);
});

test('already-held items are never reduced and approvals outside the request are refused',async t=>{
 const f=fixture();withCalendar(f);const admitted=grantMoreInput([calRequest()]),e=await engine(t,f);await run(e,IncrementalAdmit,admitted.input);await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});f.time.advance(1500);
 for(const approved of [[{fragment:CAL,fields:['week']}],[{fragment:CAL,fields:['calendar'],methods:{calendar:{[CALENDAR]:['deleteEvent']}}}],[{fragment:CAL,methods:{calendar:{[CALENDAR]:['createEvent']}}}],[{fragment:SUMMARY,fields:['day']}],[{fragment:CAL,fields:['calendar'],extra:true}]])
  await assert.rejects(run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision:{approved}}),{code:'invalid_args'},JSON.stringify(approved));
 const {code}=await run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision:{approved:[{fragment:CAL,fields:['calendar']}]}});assert(code);
 assert.deepEqual(f.p.grants.get(`${subject}|${tasks.id}|${CAL}`).fields.sort(),['calendar','color']);
});

test('configure: configured, unchanged, and the grants port is never called',async t=>{
 const f=fixture();f.p.grant(tasks.id,SUMMARY,{fields:['day','enabled'],methods:{}});f.p.prefs.set(`${subject}|${SUMMARY}`,{revision:'r0',values:{day:'friday',enabled:false}});
 const admitted=configureInput({fragment:SUMMARY,fields:['day','enabled']},{values:{day:'monday',enabled:true}});
 const {begun,completion}=await flow(t,f,admitted,{changes:[{field:'day',take:'suggested',via:'bulk'},{field:'enabled',value:false}]});
 assert.deepEqual(begun.view.fields.map(x=>[x.name,x.current,x.suggested,x.sensitive]),[['day','friday','monday',false],['enabled',false,true,false]]);
 assert.deepEqual(completion,{result:'configured'});assert.deepEqual(f.p.calls.saves,[{fragment:SUMMARY,values:{day:'monday',enabled:false}}]);assert.equal(f.p.calls.commit,0);
 const g=fixture();g.p.grant(tasks.id,SUMMARY,{fields:['day'],methods:{}});g.p.prefs.set(`${subject}|${SUMMARY}`,{revision:'r0',values:{day:'friday'}});
 const same=await flow(t,g,configureInput({fragment:SUMMARY},{values:{day:'monday'}}),{changes:[{field:'day',value:'friday'}]});assert.deepEqual(same.completion,{result:'unchanged'});
 const h=fixture();h.p.grant(tasks.id,SUMMARY,{fields:['day'],methods:{}});const declined=await flow(t,h,configureInput({fragment:SUMMARY}),{denied:true});assert.deepEqual(declined.completion,{result:'unchanged'});assert.equal(h.p.calls.save+h.p.calls.commit,0);
});

test('configure suggestions that would sneak in a grant, a destination or a foreign field are refused at creation',async t=>{
 const f=fixture();f.p.grant(tasks.id,SUMMARY,{fields:['day','forward','target'],methods:{}});const e=await engine(t,f);
 const attempts=[
  [{fragment:SUMMARY,fields:['day']},{values:{enabled:true}}],                     // field outside the target
  [{fragment:SUMMARY},{values:{label:'x'}}],                                       // field the app holds no grant on
  [{fragment:SUMMARY,fields:['day','label']},undefined],                           // target field outside the grant
  [{fragment:SUMMARY,fields:['target']},{values:{target:'https://hooks.tasks.example/r'}}], // resource value (nominates a destination)
  [{fragment:SUMMARY,fields:['day']},{values:{day:'sunday'}}],                     // schema violation
  [{fragment:CAL},undefined],                                                      // fragment not covered by any grant
 ];
 for(const [target,suggestion] of attempts)await assert.rejects(run(e,IncrementalAdmit,configureInput(target,suggestion).input),{code:'invalid_request'},JSON.stringify([target,suggestion]));
 for(const suggestion of [{values:{day:'monday'},grants:[{fragment:CAL}]},{values:{day:'monday'},methods:{}},{values:{day:{resource:'x',scope:{}}}},{values:{}}])assert.throws(()=>incrementalMembers({intent:'configure',target:{fragment:SUMMARY,fields:['day']},suggestion}),{code:'invalid_request'});
 // A configure decision cannot carry approvals.
 f.p.prefs.set(`${subject}|${SUMMARY}`,{revision:'r0',values:{day:'friday'}});const admitted=configureInput({fragment:SUMMARY,fields:['day']},{values:{day:'monday'}});await run(e,IncrementalAdmit,admitted.input);await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});f.time.advance(1500);
 await assert.rejects(run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision:{changes:[],approved:[{fragment:SUMMARY,fields:['label']}]}}),{code:'invalid_args'});assert.equal(f.p.calls.commit,0);
});

test('sensitive suggestions need their own acceptance; shared fields need the shared-change confirmation; hosts are shown',async t=>{
 const f=fixture();f.p.grant(tasks.id,SUMMARY,{fields:['day','forward','email','secret','shared'],methods:{}});f.p.prefs.set(`${subject}|${SUMMARY}`,{revision:'r0',values:{day:'friday',shared:'old'}});f.p.receivers.set(`${SUMMARY}#shared`,[{name:'Mail',kind:'app'}]);
 const admitted=configureInput({fragment:SUMMARY,fields:['day','forward','email','secret','shared']},{values:{day:'monday',forward:'https://hooks.tasks.example/x',email:'me@relay.example',secret:'s',shared:'new'}}),e=await engine(t,f);
 await run(e,IncrementalAdmit,admitted.input);const {view}=await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});f.time.advance(1500);
 assert.deepEqual(Object.fromEntries(view.fields.map(x=>[x.name,x.sensitivity])),{day:[],forward:['url'],email:['email'],secret:['marked'],shared:['shared']});
 assert.equal(view.fields.find(x=>x.name==='forward').suggestedHost,'hooks.tasks.example');assert.equal(view.fields.find(x=>x.name==='email').suggestedHost,'relay.example');assert.deepEqual(view.fields.find(x=>x.name==='shared').receivers,[{name:'Mail',kind:'app'}]);
 const decide=decision=>run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision});
 for(const field of ['forward','email','secret','shared'])await assert.rejects(decide({changes:[{field:'day',take:'suggested',via:'bulk'},{field,take:'suggested',via:'bulk'}],sharedAcknowledged:true}),{code:'individual_acceptance_required'},field);
 await assert.rejects(decide({changes:[{field:'shared',take:'suggested',via:'field'}]}),{code:'shared_confirmation_required'});
 await assert.rejects(decide({changes:[{field:'forward',take:'suggested',via:'field',value:'https://evil.example'}]}),{code:'invalid_args'},'a suggested value always comes from the stored suggestion');
 assert.equal(f.p.calls.save,0);
 assert.deepEqual(await decide({changes:[{field:'forward',take:'suggested',via:'field'},{field:'shared',take:'suggested',via:'field'}],sharedAcknowledged:true}),{result:'configured'});
 assert.deepEqual(f.p.calls.saves[0].values,{day:'friday',shared:'new',forward:'https://hooks.tasks.example/x'});
});

test('entry members: optional-only requests, bounds, inert reason and intent-specific members',()=>{
 const ok={intent:'grant-more',requests:[calRequest()]};assert.equal(incrementalMembers(ok).requests.length,1);assert.equal(incrementalMembers({...ok,requests:[calRequest({required:false})]}).requests[0].required,undefined);
 for(const input of [{...ok,requests:[calRequest({required:true})]},{...ok,requests:Array.from({length:5},(_,n)=>calRequest({fragment:`https://cal.example/p/${n}`}))},{...ok,requests:[]},{...ok,target:{fragment:SUMMARY}},{...ok,suggestion:{values:{a:1}}},{...ok,reason:'x'.repeat(201)},{...ok,reason:'line break'},{...ok,requests:[calRequest(),calRequest()]},{...ok,requests:[calRequest({digest:'nope'})]},
  {intent:'configure',requests:[],target:{fragment:SUMMARY}},{intent:'configure',target:{fragment:SUMMARY,fields:Array.from({length:9},(_,n)=>`f${n}`)}},{intent:'configure',target:{fragment:SUMMARY,fields:['day']},suggestion:{values:{day:'x'.repeat(2100)}}},{intent:'configure',target:{fragment:'http://tasks.example/x'}}])
  assert.throws(()=>incrementalMembers(input),{code:'invalid_request'},JSON.stringify(input).slice(0,120));
 assert.equal(incrementalMembers({...ok,reason:'😀'.repeat(200)}).reason.length,400,'200 code points');
});

test('unreviewed apps cannot request act-as-you access (CX-1 tier 4); reviewed apps can',async t=>{
 const f=fixture(),e=await engine(t,f),send={fragment:MAILPREF,purpose:'Send reminders.',fields:['outbox'],methods:{outbox:{[MAIL]:['send']}}};
 await assert.rejects(run(e,IncrementalAdmit,grantMoreInput([send],{client:stranger}).input),{code:'invalid_request'});
 await run(e,IncrementalAdmit,grantMoreInput([{...send,methods:{outbox:{[MAIL]:['list']}}}],{client:stranger}).input);
 await run(e,IncrementalAdmit,grantMoreInput([send]).input);
});

test('self-nomination: same-site candidates are filtered and occupants are never replaced inside a request',async t=>{
 assert.deepEqual(occupantCandidates([{id:'a',origin:'https://cal.tasks.example'},{id:'b',origin:'https://cal.example'},{id:'c',origin:'not a url'}],'tasks.example',registrableDomain).map(c=>c.id),['b']);
 const f=fixture();f.p.grant(tasks.id,CAL,{fields:['color'],methods:{}});f.p.candidates.set(`${CAL}#calendar`,[{id:'https://provider.example/r/own',label:'Tasks calendar',origin:'https://hooks.tasks.example'},{id:'https://provider.example/r/work',label:'Work',origin:'https://cal.example'}]);
 const admitted=grantMoreInput([calRequest()]),e=await engine(t,f);await run(e,IncrementalAdmit,admitted.input);const {view}=await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});f.time.advance(1500);
 assert.deepEqual(view.requests[0].setup,[{field:'calendar',type:'resource',candidates:[{id:'https://provider.example/r/work',label:'Work',origin:'https://cal.example'}]}]);
 const decide=decision=>run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision});
 await assert.rejects(decide({approved:[{fragment:CAL,fields:['calendar']}],setup:[{fragment:CAL,values:{calendar:'https://provider.example/r/own'}}]}),{code:'invalid_args'});
 f.p.prefs.set(`${subject}|${CAL}`,{revision:'r0',values:{calendar:'https://provider.example/r/work'}});
 await assert.rejects(decide({approved:[{fragment:CAL,fields:['calendar']}],setup:[{fragment:CAL,values:{calendar:'https://provider.example/r/work'}}]}),{code:'replace_in_settings'});
 assert.equal(f.p.calls.commit,0);
});

test('helpers: delta, outcome and sensitivity are pure',()=>{
 const request=calRequest({fields:['calendar','color']});assert.deepEqual(grantDelta(request,{fields:['color'],methods:{calendar:{[CALENDAR]:['createEvent']}}}),{fields:['calendar'],methods:{},empty:false});
 assert.deepEqual(fragmentOutcome({...request,status:'unavailable'}),{fragment:CAL,outcome:'unavailable'});assert.equal(fragmentOutcome(request,null,null).outcome,'declined');
 assert.deepEqual(fieldSensitivity({type:'string',format:'hostname'}),{sensitive:true,reasons:['hostname']});assert.deepEqual(fieldSensitivity({type:'enum'}),{sensitive:false,reasons:[]});
});

test('the flag gates every operation (absent, false and non-boolean values are off)',async t=>{
 for(const flag of [undefined,false,'false',1,'1',null]){const f=fixture(),e=await engine(t,f,{INCREMENTAL_AUTH_ENABLED:flag});await assert.rejects(run(e,IncrementalAdmit,grantMoreInput([calRequest()]).input),{code:'not_found'});}
 assert.deepEqual(Object.keys(INCREMENTAL_OPERATIONS).sort(),['federation.incremental.abandon','federation.incremental.admit','federation.incremental.begin','federation.incremental.cleanup','federation.incremental.decide','federation.incremental.erase','federation.incremental.exchange','federation.incremental.export','federation.incremental.login-delta','federation.incremental.login-outcome','federation.incremental.owner-acted','federation.incremental.suppress','federation.incremental.suppressions','federation.incremental.unsuppress']);
});

test('abandon completes declined / unchanged without the owner; decisions before the arming dwell are refused',async t=>{
 const f=fixture();withCalendar(f);const admitted=grantMoreInput([calRequest()]),e=await engine(t,f);await run(e,IncrementalAdmit,admitted.input);await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});
 await assert.rejects(run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision:{denied:true}}),{code:'decision_not_armed'});
 const {code}=await run(e,IncrementalAbandon,{entryHash:admitted.input.entryHash});assert.deepEqual((await exchange(e,admitted,code)).fragment_outcomes,[{fragment:CAL,outcome:'declined'}]);
 await assert.rejects(run(e,IncrementalAbandon,{entryHash:admitted.input.entryHash}),{code:'invalid_request'});
 const other=grantMoreInput([calRequest()]);await assert.rejects(run(e,IncrementalAdmit,{...other.input,subject:`https://provider.example/entities/${'9'.repeat(8)}-0000-4000-8000-000000000000`}),{code:'invalid_request'},'no live connection for that subject');
 assert.equal(CAL2.length>0,true);
});

test('review fixes: unclassifiable contracts, resource nomination, setup overwrite and cancel during Allow',async t=>{
 // IA-R1: an unreviewed app asking for a contract the consent facts cannot classify is refused (treated as tier 4).
 const f=fixture(),e=await engine(t,f);await assert.rejects(run(e,IncrementalAdmit,grantMoreInput([{fragment:CAL,purpose:'x',fields:['calendar'],methods:{calendar:{[CALENDAR]:['unknownMethod']}}}],{client:stranger}).input),{code:'invalid_request'});
 // IA-R7: resources only from the filtered candidates, for a field without resources.
 withCalendar(f);f.p.candidates.set(`${CAL}#calendar`,[{id:'https://provider.example/r/own',origin:'https://hooks.tasks.example'},{id:'https://provider.example/r/work',origin:'https://cal.example'}]);
 const a=grantMoreInput([calRequest({fields:['calendar','week']})]);await run(e,IncrementalAdmit,a.input);await run(e,IncrementalBegin,{entryHash:a.input.entryHash,subject});f.time.advance(1500);
 await assert.rejects(run(e,IncrementalDecide,{entryHash:a.input.entryHash,subject,decision:{approved:[{fragment:CAL,fields:['calendar'],resources:{calendar:['https://provider.example/r/own']}}]}}),{code:'invalid_args'});
 // IA-R9: setup cannot overwrite an existing value.
 f.p.prefs.set(`${subject}|${CAL}`,{revision:'r0',values:{color:'red'}});
 await assert.rejects(run(e,IncrementalDecide,{entryHash:a.input.entryHash,subject,decision:{approved:[{fragment:CAL,fields:['calendar']}],setup:[{fragment:CAL,values:{week:'monday'}}]}}),{code:'replace_in_settings'},'a field the owner is not approving');
 f.p.prefs.set(`${subject}|${CAL}`,{revision:'r0',values:{color:'red',week:'sunday'}});
 await assert.rejects(run(e,IncrementalDecide,{entryHash:a.input.entryHash,subject,decision:{approved:[{fragment:CAL,fields:['calendar','week']}],setup:[{fragment:CAL,values:{week:'monday'}}]}}),{code:'replace_in_settings'},'an existing value');
 // IA-R8: a cancel landing while Allow commits is refused; the decision completes with the committed outcome.
 const commit=f.p.grantsPort.commit;let cancel;f.p.grantsPort.commit=async input=>{cancel=run(e,IncrementalAbandon,{entryHash:a.input.entryHash}).then(()=>'abandoned',error=>error.code);return commit(input);};
 const done=await run(e,IncrementalDecide,{entryHash:a.input.entryHash,subject,decision:{approved:[{fragment:CAL,fields:['calendar'],resources:{calendar:['https://provider.example/r/work']}}]}});
 assert.equal(await cancel,'invalid_request');assert.equal((await exchange(e,a,done.code)).fragment_outcomes[0].outcome,'partial');
});

test('a decision whose setup saved but whose grant commit failed resumes idempotently after the lease',async t=>{
 const f=fixture();withCalendar(f);const admitted=grantMoreInput([calRequest({fields:['calendar','week']})]),e=await engine(t,f);await run(e,IncrementalAdmit,admitted.input);await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});f.time.advance(1500);
 const decision={approved:[{fragment:CAL,fields:['calendar','week'],methods:{calendar:{[CALENDAR]:['createEvent']}}}],setup:[{fragment:CAL,values:{week:'monday'}}]};
 const commit=f.p.grantsPort.commit;let failures=1;f.p.grantsPort.commit=async input=>{if(failures-->0)throw Object.assign(new Error('busy'),{code:'temporarily_unavailable'});return commit(input);};
 const go=input=>run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision:input});
 await assert.rejects(go(decision),{code:'temporarily_unavailable'});assert.equal(f.p.calls.save,1,'setup saved before the commit failed');
 await assert.rejects(go(decision),{code:'decision_in_progress'},'inside the lease');f.time.advance(30000);
 await assert.rejects(go({denied:true}),{code:'decision_in_progress'},'a different decision cannot take over a committing one');
 await assert.rejects(run(e,IncrementalAbandon,{entryHash:admitted.input.entryHash}),{code:'invalid_request'});
 const done=await go(decision);assert.equal(f.p.calls.save,1,'the saved setup is not re-validated or re-saved');assert.equal(f.p.calls.commit,1,'one successful commit after the failed attempt');
 const response=await exchange(e,admitted,done.code);assert.deepEqual(response.fragment_outcomes,[{fragment:CAL,outcome:'granted',granted:{fields:['calendar','color','week'],methods:{calendar:{[CALENDAR]:['createEvent']}}}}]);assert(response.access_token);
 assert.deepEqual(await go(decision),done,'later retries return the stored completion');
});

test('a configure save that succeeded before a failure resumes as configured, never unchanged',async t=>{
 const f=fixture();f.p.grant(tasks.id,SUMMARY,{fields:['day'],methods:{}});f.p.prefs.set(`${subject}|${SUMMARY}`,{revision:'r0',values:{day:'friday'}});
 const admitted=configureInput({fragment:SUMMARY},{values:{day:'monday'}}),e=await engine(t,f);await run(e,IncrementalAdmit,admitted.input);await run(e,IncrementalBegin,{entryHash:admitted.input.entryHash,subject});f.time.advance(1500);
 const save=f.p.preferencesPort.save;let failures=1;f.p.preferencesPort.save=async input=>{const out=await save(input);if(failures-->0)throw Object.assign(new Error('lost reply'),{code:'temporarily_unavailable'});return out;};
 const decision={changes:[{field:'day',take:'suggested',via:'field'}]},go=()=>run(e,IncrementalDecide,{entryHash:admitted.input.entryHash,subject,decision});
 await assert.rejects(go(),{code:'temporarily_unavailable'});f.time.advance(30000);assert.deepEqual(await go(),{result:'configured'});assert.equal(f.p.calls.save,1);assert.equal(f.p.calls.commit,0);
});

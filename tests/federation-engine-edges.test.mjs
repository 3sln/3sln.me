// Engine-level federation edges: AuthorizationEntries, FederationService and DPoP primitives with in-memory stores
// and frozen clocks. No HTTP handler is involved; behaviour is asserted as rules, not recorded outputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {MemoryFederationStore} from '../packages/federation/index.mjs';
import {dpopNonces,consumeProof} from '../packages/federation/dpop.mjs';
import {provider,codeOf} from './authorization-entry-helpers.mjs';
import {ctx,entry,serviceFixture,owner,app,callback,pkce} from './federation-engine-helpers.mjs';
import {fakeClock} from './helpers/chaos.mjs';

// ---- Entry state machine: every operation in every state, for every intent -------------------------------------
const intents={login:()=>({}),'select-account':()=>({intent:'select-account'}),reauthenticate:p=>({intent:'reauthenticate',subjectConstraint:p.accounts[0].subject,maxAge:300})};
// Each state is built from public operations only. `deciding` is a decision whose owner-shard outcome is unknown
// (a non-releasing failure), so the hold stays with alex but the entry is not completed.
const states={
 fresh:async()=>{},
 selected:async(p,e,alex)=>{await p.entries.select(e.entryId,ctx(alex),{nonce:e.nonce},e.page);},
 deciding:async(p,e,alex)=>{await p.entries.select(e.entryId,ctx(alex),{nonce:e.nonce},e.page);const approve=p.authority.approve;p.authority.approve=async()=>{throw Object.assign(new Error('unknown outcome'),{code:'temporarily_unavailable'});};await assert.rejects(p.entries.decide(e.entryId,ctx(alex),{nonce:e.nonce,approved:[]},e.page),{code:'temporarily_unavailable'});p.authority.approve=approve;},
 completed:async(p,e,alex)=>{await p.entries.select(e.entryId,ctx(alex),{nonce:e.nonce},e.page);await p.entries.decide(e.entryId,ctx(alex),{nonce:e.nonce,approved:[]},e.page);},
 cancelled:async(p,e)=>{await p.entries.cancel(e.entryId,{nonce:e.nonce},e.page);},
 expired:async p=>{p.time.advance(600000);},
};
const terminal=new Set(['completed','cancelled','expired']);
const ops={
 view:(p,e)=>p.entries.view(e.entryId),
 select:(p,e,alex)=>p.entries.select(e.entryId,ctx(alex),{nonce:e.nonce},e.page),
 decide:(p,e,alex)=>p.entries.decide(e.entryId,ctx(alex),{nonce:e.nonce,approved:[]},e.page),
 decideOther:async(p,e,alex,sam)=>{await p.entries.select(e.entryId,ctx(sam),{nonce:e.nonce},e.page);return p.entries.decide(e.entryId,ctx(sam),{nonce:e.nonce,approved:[]},e.page);},
 cancel:(p,e)=>p.entries.cancel(e.entryId,{nonce:e.nonce},e.page),
};
// The rule: terminal entries look expired to every operation; live entries accept views, selections and cancels;
// a decision needs the caller's own selection and is refused while another account holds the entry; a constrained
// (reauthenticate) entry refuses every other account.
function expected(intent,state,op){
 if(terminal.has(state))return {code:'invalid_request'};
 if(op==='decide'&&state==='fresh')return {code:'invalid_request'};
 if(op==='decideOther'&&intent==='reauthenticate')return {code:'account_mismatch'};
 if(op==='decideOther'&&state==='deciding')return {code:'invalid_request'};
 return 'ok';
}
for(const [intent,overrides] of Object.entries(intents))test(`entry ${intent}: every operation in every state follows the entry rule`,async()=>{
 for(const [state,build] of Object.entries(states))for(const [op,run] of Object.entries(ops)){
  const p=await provider(),alex=p.signIn(p.accounts[0]),sam=p.signIn(p.accounts[1]),e=await entry(p,overrides(p));await build(p,e,alex);
  const want=expected(intent,state,op),label=`${intent}/${state}/${op}`;
  if(want==='ok'){const result=await run(p,e,alex,sam);
   if(op.startsWith('decide'))assert.ok(codeOf(result.redirectUri),label);
   if(op==='cancel')assert.equal(new URL(result.redirectUri).searchParams.get('error'),'access_denied',label);
   if(op.startsWith('decide')||op==='cancel')await assert.rejects(p.entries.view(e.entryId),{code:'invalid_request'},`${label}: an outcome ends the entry`);
  }else await assert.rejects(run(p,e,alex,sam),want,label);
 }
});

test('entry end-session: only the confirm route works, once, and owner/decision routes never apply',async()=>{
 for(const state of ['fresh','finished','expired'])for(const op of ['view','select','decide','cancel','endTarget','finish']){
  const p=await provider({endSession:true}),alex=p.signIn(),e=await entry(p,{intent:'end-session',subjectConstraint:p.accounts[0].subject});
  if(state==='finished')await p.entries.finishSession(e.entryId,{nonce:e.nonce,confirmed:true},e.page);if(state==='expired')p.time.advance(600000);
  const run={view:()=>p.entries.view(e.entryId),select:()=>ops.select(p,e,alex),decide:()=>ops.decide(p,e,alex),cancel:()=>ops.cancel(p,e),endTarget:()=>p.entries.endTarget(e.entryId,{nonce:e.nonce,confirmed:true},e.page),finish:()=>p.entries.finishSession(e.entryId,{nonce:e.nonce,confirmed:false},e.page)}[op];
  if(state!=='fresh'||['select','decide','cancel'].includes(op)){await assert.rejects(run(),{code:'invalid_request'},`${state}/${op}`);continue;}
  const result=await run();if(op==='endTarget')assert.equal(result.subject,p.accounts[0].subject);if(op==='finish')assert.equal(new URL(result.redirectUri).searchParams.get('result'),'canceled');
 }
});

test('entry page token and nonce are both required for every page mutation',async()=>{
 const p=await provider(),alex=p.signIn(),e=await entry(p),other=await entry(p);
 await assert.rejects(p.entries.select(e.entryId,ctx(alex),{nonce:e.nonce},other.page),{code:'csrf'});
 await assert.rejects(p.entries.select(e.entryId,ctx(alex),{nonce:other.nonce},e.page),{code:'invalid_request'});
 await assert.rejects(p.entries.cancel(e.entryId,{nonce:e.nonce},{}),{code:'csrf'});
 // A session without its CSRF secret cannot select, and nothing was recorded for it.
 await assert.rejects(p.entries.select(e.entryId,{...ctx(alex),csrfToken:'wrong'},{nonce:e.nonce},e.page),{code:'csrf'});
 await assert.rejects(p.entries.decide(e.entryId,ctx(alex),{nonce:e.nonce,approved:[]},e.page),{code:'invalid_request'});
});

// ---- FederationService code, token and revocation boundaries ---------------------------------------------------
test('code and access-token lifetimes end exactly at their boundary instant',async()=>{
 const f=await serviceFixture(),early=await f.connect(),late=await f.connect();
 f.clock.advance(59999);const issued=await f.exchange(early);
 f.clock.advance(1);await assert.rejects(f.exchange(late),{code:'invalid_grant'});
 assert.equal(issued.expires_in,300);assert.equal(await f.alive(issued.access_token),true);
 f.clock.advance(299998);assert.equal(await f.alive(issued.access_token),true,'one millisecond before expiry');
 f.clock.advance(1);assert.equal(await f.alive(issued.access_token),false);
 // The refresh family outlives the access token and issues a fresh one.
 const renewed=await f.refresh(issued.refresh_token);assert.equal(await f.alive(renewed.access_token),true);
});

test('revocation cascades: a revoked grant kills access, child resource and refresh tokens together',async()=>{
 const f=await serviceFixture(),issued=await f.exchange(await f.connect()),[child]=(await f.read(issued.access_token)).result.values.stores;
 assert.equal(await f.alive(child.token,child.id),true);
 await f.service.revoke(owner,issued.grants[0]);
 assert.equal(await f.alive(issued.access_token),false);assert.equal(await f.alive(child.token,child.id),false);
 await assert.rejects(f.refresh(issued.refresh_token),{code:'unauthorized'});
});

test('RFC 7009: revoking a refresh token ends its family and access; an access-only revocation keeps the family',async()=>{
 const f=await serviceFixture(),a=await f.exchange(await f.connect()),b=await f.exchange(await f.connect());
 // A foreign client and an unknown token are silent no-ops that change nothing.
 f.service.clients.set('https://other.example/client',{id:'https://other.example/client',name:'Other',origin:'https://other.example',redirectUris:['https://other.example/cb']});
 assert.deepEqual(await f.service.revokeToken({token:a.refresh_token,clientId:'https://other.example/client'}),{});
 assert.deepEqual(await f.service.revokeToken({token:'x'.repeat(43),clientId:app}),{});assert.equal(await f.alive(a.access_token),true);
 await f.service.revokeToken({token:a.refresh_token,clientId:app});
 assert.equal(await f.alive(a.access_token),false);await assert.rejects(f.refresh(a.refresh_token),{code:'invalid_grant'});
 await f.service.revokeToken({token:b.access_token,clientId:app});
 assert.equal(await f.alive(b.access_token),false);const renewed=await f.refresh(b.refresh_token);assert.equal(await f.alive(renewed.access_token),true);
});

test('refresh reuse after rotation revokes the successor and every access token of the family',async()=>{
 const f=await serviceFixture(),first=await f.exchange(await f.connect()),second=await f.refresh(first.refresh_token);
 await assert.rejects(f.refresh(first.refresh_token),{code:'invalid_grant'});
 await assert.rejects(f.refresh(second.refresh_token),{code:'invalid_grant'});
 for(const token of [first.access_token,second.access_token])assert.equal(await f.alive(token),false);
});

test('a pending request cap of 32 is enforced, and expiry frees capacity without unbounded growth',async()=>{
 const f=await serviceFixture(),begin=()=>f.service.beginAuthorization({clientId:app,redirectUri:callback,challenge:pkce('v'.repeat(43)),challengeMethod:'S256',state:'s',requests:[]});
 const results=await Promise.allSettled(Array.from({length:40},begin));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,32);assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='rate_limited'));
 f.clock.advance(600000);await begin();assert.equal(await f.rows('federation/request/'),1,'expired requests were pruned on admission');
 const swept=await f.service.cleanup();assert.equal(swept.remaining,true);
});

// ---- DPoP nonce and proof-record edges -------------------------------------------------------------------------
test('DPoP nonces: valid until one millisecond before expiry, and a clock jumped backwards refuses them',async()=>{
 const clock=fakeClock(),nonces=dpopNonces({secret:'s'.repeat(32),crypto:webcrypto,clock:clock.now,ttl:120000}),nonce=await nonces.issue('token');
 clock.advance(119999);assert.ok((await nonces.check('token',nonce)).hash);
 clock.advance(1);await assert.rejects(nonces.check('token',nonce),{code:'use_dpop_nonce'});
 // Issued "in the future" relative to a rewound clock: more than one ttl ahead, so refused.
 const later=await nonces.issue('token');clock.advance(-1);await assert.rejects(nonces.check('token',later),{code:'use_dpop_nonce'});
});

test('DPoP proof records: jti is unique per key, replays fail, and the live set is bounded and self-pruning',async()=>{
 const clock=fakeClock(),store=new MemoryFederationStore(),consume=(proof,max)=>store.transaction(tx=>consumeProof(tx,'dpop/',proof,webcrypto,clock.now,max));
 const proof=(jkt,jti,extra={})=>({jkt,jti,nonceHash:null,expiresAt:clock.now()+60000,...extra});
 await consume(proof('A'.repeat(43),'j'.repeat(16)));await consume(proof('B'.repeat(43),'j'.repeat(16)));
 await assert.rejects(consume(proof('A'.repeat(43),'j'.repeat(16))),{code:'invalid_dpop_proof'});
 await consume(proof('C'.repeat(43),'k'.repeat(16),{nonceHash:'n'.repeat(43)}));
 await assert.rejects(consume(proof('D'.repeat(43),'l'.repeat(16),{nonceHash:'n'.repeat(43)})),{code:'use_dpop_nonce'});
 const live=await store.transaction(tx=>tx.list('dpop/'));
 for(let i=live.length;i+2<=8;i++)await consume(proof('E'.repeat(43),`fill-${String(i).padStart(11,'0')}`),8);
 await assert.rejects(consume(proof('F'.repeat(43),'m'.repeat(16)),8),{code:'rate_limited'});
 clock.advance(60000);await consume(proof('F'.repeat(43),'m'.repeat(16)),8);
 assert.equal((await store.transaction(tx=>tx.list('dpop/'))).length,1,'expired proof records are pruned before counting');
});

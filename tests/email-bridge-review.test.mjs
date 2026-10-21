// Regressions for the BRIDGE security review (docs/release/email-bridge-review.md, EB-1 to EB-8).
import test from 'node:test';
import assert from 'node:assert/strict';
import {world,rawMail,text,CONFIG,DOMAIN,OWNER,AUTHSERV,NOW} from './email-bridge-helpers.mjs';
import {BRIDGE_LIMITS,parseEmail,bridgeConfig,memoryStore,storeSenders} from '../packages/email-bridge/index.mjs';
import {fakeClock} from './helpers/chaos.mjs';

const ledgers=async(w,owner=OWNER)=>(await w.rows(owner,'reply/')).map(([k,l])=>({jti:k.slice(6),...l}));

test('EB-1: a sender-written Authentication-Results is never evidence without the operator attestation; no backscatter, no follow-up to a forged victim',async()=>{
 const {EMAIL_BRIDGE_AUTHSERV_STRIPS,...unattested}=CONFIG;assert.equal(bridgeConfig(unattested).authservId,null);assert.ok(EMAIL_BRIDGE_AUTHSERV_STRIPS);
 const w=await world({config:unattested});await w.enable();
 const forged=rawMail({from:'victim@victim.example',auth:null,headers:[`Authentication-Results: ${AUTHSERV}; dmarc=pass`]});
 assert.equal((await w.receive(forged,{from:'victim@victim.example'})).action,'accept');assert.equal(w.replies.length,0,'Node trusted gate: unknown DMARC, no reply');
 const [l]=await ledgers(w);assert.equal(l.dmarc,'unknown');assert.deepEqual(await w.bridge.accepted(OWNER,l.jti),{status:'suppressed'});assert.equal(w.mails.length,0);
 await w.bridge.drain(OWNER);assert.equal(JSON.parse(atob(w.deliveries[0].rpc.args.provenance.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).dmarc,'unknown','provenance carries no forged pass');
});

test('EB-1: under the platform gate a follow-up needs the platform to have actually sent the reply, whatever a header claims',async()=>{
 const {runOwnerOperation}=await import('../packages/email-bridge/index.mjs');const storage=memoryStore(),senders=memoryStore(),mail=[];
 const env={...CONFIG,EMAIL_BRIDGE:{idFromName:n=>n,get:()=>({senders:(m,k,o)=>storeSenders(senders)[m](k,o)})},ACCOUNTS:{idFromName:n=>n,get:()=>({invoke:async()=>({$fault:{code:'not_found',message:'x'}})})},MAIL_ENABLED:'true',MAIL_SENDER_DOMAIN:'sys.3sln.example',EMAIL:{send:async m=>{mail.push(m);return {messageId:'1'};}}};
 await runOwnerOperation(env,storage,'bridge.configure',OWNER,{enabled:true});
 const parsed=await parseEmail(rawMail({from:'victim@victim.example'}),{envelopeFrom:'victim@victim.example',authservId:AUTHSERV});assert.equal(parsed.auth.dmarc,'pass');
 const out=await runOwnerOperation(env,storage,'bridge.admit',OWNER,{envelope:{from:'victim@victim.example',to:`bob@${DOMAIN}`},principal:{issuer:CONFIG.APP_ORIGIN,subject:OWNER,identityURI:`${CONFIG.APP_ORIGIN}/identity/${OWNER}`},parsed,dmarcGate:'platform'});
 assert.ok(out.reply);await runOwnerOperation(env,storage,'bridge.reply-outcome',OWNER,{jti:out.reply.jti,outcome:'failed',code:'E_DMARC'});
 assert.deepEqual(await runOwnerOperation(env,storage,'bridge.accepted',OWNER,{jti:out.reply.jti}),{status:'suppressed'});assert.equal(mail.length,0);
});

test('EB-2: budgets are charged narrowest-first and refunded when no reply goes out',async()=>{
 const w=await world();await w.enable();
 for(let i=0;i<BRIDGE_LIMITS.senderIntakeDaily;i++)await w.receive(rawMail({messageId:`<s${i}@x>`,body:`m${i}`}));
 assert.equal(w.replies.length,1);const [[,replies]]=(await w.rows(OWNER,'budget/replies'));assert.equal(replies.count,1,'one sender spends one recipient unit');
 assert.equal((await w.senderStore.get('w/global/replies-v1')).count,1);
 // A platform refusal (forged sender failing DMARC) gives the recipient, domain and global units back.
 const f=await world({sendReply:async()=>{throw Object.assign(new Error('dmarc'),{code:'E_DMARC'});}});await f.enable();await f.receive(rawMail());
 assert.equal((await f.senderStore.get('w/global/replies-v1')).count,0);assert.equal((await f.rows(OWNER,'budget/replies'))[0][1].count,0);
 // A global miss gives the sender's cooldown back: once budget returns, that sender is answered.
 const g=await world();await g.enable();await g.senderStore.put('w/global/replies-v1',{start:NOW,count:BRIDGE_LIMITS.globalRepliesDaily,until:NOW+86400000});
 await g.receive(rawMail());assert.equal(g.replies.length,0);g.clock.advance(86400000);await g.receive(rawMail({messageId:'<next@x>',body:'next'}));assert.equal(g.replies.length,1);
});

test('EB-3: mail to nonexistent handles never charges the ingress budget; one sender cannot fill a recipient\'s day',async()=>{
 const w=await world();await w.enable();
 for(let i=0;i<5;i++)await w.receive(rawMail(),{to:`ghost${i}@${DOMAIN}`});const keys=[...(await w.limiterStore.list({prefix:'w/'})).keys()];
 assert.equal(keys.some(k=>k.includes('ingress')),false);assert.deepEqual(keys.map(k=>k.replace(/\d+$/,'N')),['w/email-bridge/source-v1/N'],'only the bounded per-source bucket throttles directory lookups');
 for(let i=0;i<BRIDGE_LIMITS.senderIntakeDaily+3;i++)await w.receive(rawMail({messageId:`<f${i}@x>`,body:`f${i}`}));
 assert.equal((await w.rows(OWNER,'item/')).length,BRIDGE_LIMITS.senderIntakeDaily);
 assert.equal((await w.receive(rawMail({from:'other@sender2.example',messageId:'<o@x>'}),{from:'other@sender2.example'})).action,'accept','another sender still gets through');
});

test('EB-6: bidi, C1 and zero-width characters never reach provenance display fields',async()=>{
 const parsed=await parseEmail(rawMail({header:'"‮elpmaxe.knab@ofni​\u0085" <a@attacker.example>'}),{envelopeFrom:'a@attacker.example'});
 assert.equal(/[‮​\u0085]/.test(parsed.headerFrom),false);assert.match(parsed.headerFrom,/<a@attacker\.example>$/);
});

test('EB-7: a failing sender store costs the reply, never the acceptance',async()=>{
 const broken={consume:async()=>{throw new Error('shard down');},suppressed:async()=>{throw new Error('shard down');},suppress:async()=>{},refund:async()=>{}};
 const w=await world({senders:broken});await w.enable();assert.equal((await w.receive(rawMail())).action,'accept');assert.equal(w.replies.length,0);
 assert.equal((await ledgers(w))[0].initial,'suppressed:error');assert.equal((await w.rows(OWNER,'queue/')).length,1);
});

test('refunds name their window: a refund after a rollover never lowers the new window',async()=>{
 const clock=fakeClock(NOW),s=storeSenders(memoryStore(),{clock}),start=await s.consume('k',{limit:2,windowMs:3600000});
 clock.advance(3600001);await s.consume('k',{limit:2,windowMs:3600000});await s.refund('k',{start});
 assert.ok(await s.consume('k',{limit:2,windowMs:3600000}));assert.equal(await s.consume('k',{limit:2,windowMs:3600000}),false);
});

test('EB-8: sender windows expire through an end-time index, whatever their key order',async()=>{
 const clock=fakeClock(NOW),store=memoryStore(),s=storeSenders(store,{clock});
 await s.consume('domain/aaa',{limit:5,windowMs:86400000});await s.consume('sender/zzz',{limit:1,windowMs:3600000});
 clock.advance(2*3600000);await s.consume('global/x',{limit:5,windowMs:86400000});
 assert.equal(await store.get('w/sender/zzz'),undefined,'expired late-sorting key removed');assert.ok(await store.get('w/domain/aaa'));
 assert.ok(await s.consume('sender/zzz',{limit:1,windowMs:3600000}));
});

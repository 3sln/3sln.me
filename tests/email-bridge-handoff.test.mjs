// BRIDGE handoff: (1) the bridge's drain delivers through the brokered resource port to the real BB-B7 receiver,
// which verifies our provenance and stores an unverified channel item; (2) the Worker `email` handler adapter with a
// fake Email Routing event and fake bindings: generic refusal, platform reply, outcome recording and fail-closed ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {world,rawMail,text,bridgeKey,CONFIG,DOMAIN,OWNER,ORIGIN,PRINCIPAL,RESOURCE,NOW} from './email-bridge-helpers.mjs';
import {createTestEngine,memoryStore as boxStore} from './bindlebox/helpers/engine.mjs';
import {fakeClock} from './helpers/chaos.mjs';
import {ContactsDomain,ReceiveDomain} from '../packages/bindlebox-engine/store/mailbox.mjs';
import {createBridgeProvider,BridgeReceive as BoxReceive} from '../packages/bindlebox-engine/domains/bridge.mjs';
import {handleEmail,runOwnerOperation,runSenderMethod,memoryStore,GENERIC_REFUSAL,invariantText,bridgeObjectName} from '../packages/email-bridge/index.mjs';

async function bindlebox(t,{clock,key,enabled=true}){
 const egress={fetch:async()=>{throw new Error('egress forbidden');},send:async()=>{throw new Error('egress forbidden');}};
 const providerLink={async consumerKey({consumer,keyId}){return consumer===ORIGIN&&keyId===key.keyId?{keyId,publicJwk:key.publicJwk}:null;}};
 const e=createTestEngine({owner:OWNER,clock,store:boxStore([['owner',OWNER]]),providers:{contacts:ContactsDomain,receive:ReceiveDomain,bridge:createBridgeProvider({BINDLEBOX_ENABLED:enabled}),providerLink,classifier:{decide:async()=>({labels:{spam:0},evidence:{model:'m',version:'1',schema:'s'}})},egress,userStorage:null}});
 t.after(()=>e.dispose());
 if(enabled)await e.run('receive.configure',{input:{principal:PRINCIPAL,ingress:'https://hub.box.example/ingress'}});
 const call=async({body,seat})=>{const tx=JSON.parse(text(body)).tx;try{return {status:200,json:{version:'0',tx,result:await e.perform(new BoxReceive({actor:{kind:'ingress',owner:OWNER},input:{body,consumer:ORIGIN,resource:seat.resource}}))}};}catch(error){return {status:error.status??400,json:{error:{code:error.code}}};}};
 return {...e,call,providerLink,items:async()=>[...(await e.store.list({prefix:'item/'})).values()]};
}

test('handoff to BB-B7: provenance verifies with the bridge key, the item is channel-origin and unverified, duplicates and re-signed retries store once',async t=>{
 const clock=fakeClock(NOW),key=await bridgeKey(),box=await bindlebox(t,{clock,key});
 const w=await world({clock,key,call:box.call});await w.enable();
 await w.receive(rawMail());await w.receive(rawMail({from:'mallory@evil.example',messageId:'<z@x>'}),{from:'mallory@evil.example'});
 assert.equal((await w.bridge.drain(OWNER)).delivered,2);
 const items=await box.items();assert.equal(items.length,2);
 for(const item of items){assert.equal(item.origin,'channel');assert.equal(item.verifiedSender,false);assert.equal(item.author,undefined);assert.equal(item.channel,'email');}
 assert.deepEqual(items.map(i=>i.asserted.dmarc).sort(),['pass','pass']);
 const status=await w.bridge.status(OWNER);assert.deepEqual(status.items.map(i=>i.disposition),['stored-receipt','stored-receipt']);
 // A crash-retry of the same held mail (same fingerprint and tx, re-signed with a new jti) is stored once by B7.
 const held=(await w.rows(OWNER,'item/')).map(([,r])=>r).find(r=>r.claims.sender.envelopeFrom==='alice@sender.example'),retry=await w.stores.for(OWNER).transaction(async tx=>{const k=[...(await tx.list({prefix:'queue/'})).keys()];return k;});assert.equal(retry.length,0);
 const signer=(await import('../packages/email-bridge/index.mjs')).provenanceSigner({privateKey:key.pair.privateKey,keyId:key.keyId});
 const fresh=await world({clock,key,call:box.call});await fresh.enable();await fresh.receive(rawMail());assert.ok(held.id);
 const [[,item]]=await fresh.rows(OWNER,'item/');assert.equal(item.id,held.id,'same owner, sender, Message-ID and content: same fingerprint');
 await fresh.bridge.drain(OWNER);assert.equal((await box.items()).length,2,'fingerprint dedup at B7');assert.ok(signer);
 // A forged provider (another key) is refused by B7 and stays a terminal owner-visible refusal at the bridge.
 const forger=await world({clock,call:box.call});await forger.enable();await forger.receive(rawMail({messageId:'<forged@x>'}));await forger.bridge.drain(OWNER);
 assert.equal((await forger.bridge.status(OWNER)).items[0].state,'queued','not_authorized (403) is held for an owner fix, never stored');
 assert.equal((await box.items()).length,2);
});

test('handoff to a disabled BindleBox bridge: the occupant answers refused; the reply that was already decided is unaffected',async t=>{
 const clock=fakeClock(NOW),key=await bridgeKey(),box=await bindlebox(t,{clock,key});await box.run('bridge.configure',{input:{enabled:false}});
 const w=await world({clock,key,call:box.call});await w.enable();await w.receive(rawMail());await w.bridge.drain(OWNER);
 assert.equal((await w.bridge.status(OWNER)).items[0].disposition,'refused');assert.equal(w.replies.length,1);assert.equal((await box.items()).length,0);
});

// ---- Worker adapter with fake bindings ----
function fakeEnv({config=CONFIG,key,accounts={},mail=[]}={}){
 const objects=new Map(),object=name=>{if(!objects.has(name))objects.set(name,memoryStore());const storage=objects.get(name);return {operate:(op,owner,input)=>runOwnerOperation(env,storage,op,owner,input),senders:(m,k,o)=>runSenderMethod(storage,m,k,o)};};
 const ns=f=>({idFromName:name=>name,get:name=>f(name)});
 const env={...config,EMAIL_BRIDGE:ns(object),IDENTITIES:ns(()=>({})),ABUSE:ns(()=>({consume:async()=>true})),
  ACCOUNTS:ns(owner=>({invoke:async({method,args})=>{const f=accounts[method];return f?f(owner,...args.slice(1)):{$fault:{code:'not_found',message:'Unknown method.'}};}})),
  MAIL_ENABLED:'true',MAIL_SENDER_DOMAIN:'sys.3sln.example',EMAIL:{send:async m=>{mail.push(m);return {messageId:'x'};}},
  ...key?{EMAIL_BRIDGE_SIGNING_JWK:JSON.stringify({kid:'k1',privateJWK:key.privateJwk})}:{}};
 return {env,objects,mail};
}
function event(raw,{from='alice@sender.example',to=`bob@${DOMAIN}`,rawSize=raw.byteLength,replyFails}={}){
 const e={from,to,rawSize,raw:new ReadableStream({start(c){c.enqueue(raw);c.close();}}),rejected:null,replies:[],setReject(reason){this.rejected=reason;},async reply(message){if(replyFails)throw Object.assign(new Error('dmarc'),{code:'E_DMARC'});this.replies.push(message);}};return e;
}
class EmailMessage{constructor(from,to,raw){Object.assign(this,{from,to,raw});}}
const edge=(directory={bob:{owner:OWNER,active:true,entitled:true,principal:PRINCIPAL}})=>({directory:{resolve:async h=>directory[h]??null},limiter:{consume:async()=>true},owners:null});

test('Worker email handler: generic setReject when off, missing bindings or unknown; platform reply once with the invariant raw bytes; failures recorded, never refused',async()=>{
 const off=fakeEnv({config:{...CONFIG,EMAIL_BRIDGE_ENABLED:'false'}}),m0=event(rawMail());await handleEmail(m0,off.env,{},{floorMs:0,EmailMessage});assert.equal(m0.rejected,GENERIC_REFUSAL);
 const {env}=fakeEnv();delete env.EMAIL_BRIDGE;const m1=event(rawMail());await handleEmail(m1,env,{},{floorMs:0,EmailMessage});assert.equal(m1.rejected,GENERIC_REFUSAL,'no object binding: fail closed');
 const f=fakeEnv(),ports=edge();ports.owners={admit:(owner,input)=>f.env.EMAIL_BRIDGE.get(bridgeObjectName(owner)).operate('bridge.admit',owner,input)};
 const unknown=event(rawMail(),{to:`nobody@${DOMAIN}`});await handleEmail(unknown,f.env,{},{floorMs:0,EmailMessage,edge:ports});assert.equal(unknown.rejected,GENERIC_REFUSAL);
 const disabled=event(rawMail());await handleEmail(disabled,f.env,{},{floorMs:0,EmailMessage,edge:ports});assert.equal(disabled.rejected,GENERIC_REFUSAL,'owner setting defaults off');
 await f.env.EMAIL_BRIDGE.get(bridgeObjectName(OWNER)).operate('bridge.configure',OWNER,{enabled:true});
 const waits=[],ok=event(rawMail({auth:null}));await handleEmail(ok,f.env,{waitUntil:p=>waits.push(p)},{floorMs:0,EmailMessage,edge:ports});await Promise.all(waits);
 assert.equal(ok.rejected,null);assert.equal(ok.replies.length,1,'the platform gate (reply() enforces DMARC) allows a reply without a trusted header');
 const [reply]=ok.replies;assert.equal(reply.from,`bob@${DOMAIN}`);assert.equal(reply.to,'alice@sender.example');assert.ok(reply.raw.replace(/\r\n/g,' ').includes(invariantText(`${ORIGIN}/`)));
 const ledger=[...(await f.objects.get(bridgeObjectName(OWNER)).list({prefix:'reply/'})).values()][0];assert.equal(ledger.initial,'sent');
 // No occupant port in core yet: the drain held the mail (integrationsIntakeSeat is unknown to the account object).
 const status=await f.env.EMAIL_BRIDGE.get(bridgeObjectName(OWNER)).operate('bridge.status',OWNER);assert.equal(status.items[0].state,'queued');assert.equal(status.items[0].reason,'no-occupant');
 // A failing platform reply (e.g. DMARC) is recorded; the accepted mail is not turned into a refusal.
 const g=fakeEnv(),gp=edge();gp.owners={admit:(o,i)=>g.env.EMAIL_BRIDGE.get(bridgeObjectName(o)).operate('bridge.admit',o,i)};await g.env.EMAIL_BRIDGE.get(bridgeObjectName(OWNER)).operate('bridge.configure',OWNER,{enabled:true});
 const bad=event(rawMail(),{replyFails:true});await handleEmail(bad,g.env,{},{floorMs:0,EmailMessage,edge:gp});assert.equal(bad.rejected,null);
 assert.equal([...(await g.objects.get(bridgeObjectName(OWNER)).list({prefix:'reply/'})).values()][0].initial,'failed');
 // Without the cloudflare:email constructor no reply is attempted at all.
 const h=fakeEnv(),hp=edge();hp.owners={admit:(o,i)=>h.env.EMAIL_BRIDGE.get(bridgeObjectName(o)).operate('bridge.admit',o,i)};await h.env.EMAIL_BRIDGE.get(bridgeObjectName(OWNER)).operate('bridge.configure',OWNER,{enabled:true});
 const none=event(rawMail());await handleEmail(none,h.env,{},{floorMs:0,edge:hp});assert.equal(none.rejected,null);assert.equal(none.replies.length,0);
 // A stream longer than its claimed size is refused generically.
 const liar=event(rawMail({body:'y'.repeat(1100000)}),{rawSize:100,from:'liar@sender.example'});await handleEmail(liar,f.env,{},{floorMs:0,EmailMessage,edge:ports});assert.equal(liar.rejected,GENERIC_REFUSAL);
});

test('Worker owner ports: signer from EMAIL_BRIDGE_SIGNING_JWK, brokered occupant via account RPC, follow-up from the notify role',async()=>{
 const key=await bridgeKey(),privateJwk=await crypto.subtle.exportKey('jwk',key.pair.privateKey);key.privateJwk=privateJwk;
 const delivered=[],f=fakeEnv({key,accounts:{integrationsIntakeSeat:()=>({id:'s1',resource:RESOURCE}),integrationsIntakeDeliver:(owner,{body})=>{const rpc=JSON.parse(text(body));delivered.push(rpc);return {status:200,json:{version:'0',tx:rpc.tx,result:{disposition:'stored-receipt'}}};}}});
 const ports=edge();ports.owners={admit:(o,i)=>f.env.EMAIL_BRIDGE.get(bridgeObjectName(o)).operate('bridge.admit',o,i)};
 const obj=f.env.EMAIL_BRIDGE.get(bridgeObjectName(OWNER));await obj.operate('bridge.configure',OWNER,{enabled:true});
 const m=event(rawMail());await handleEmail(m,f.env,{},{floorMs:0,EmailMessage,edge:ports});
 assert.equal((await obj.operate('bridge.drain',OWNER,{})).delivered,1);assert.equal(delivered.length,1);
 const [h]=delivered[0].args.provenance.split('.');assert.equal(JSON.parse(atob(h.replace(/-/g,'+').replace(/_/g,'/'))).kid,`${ORIGIN}/keys/email-bridge/k1`);
 const jti=[...(await f.objects.get(bridgeObjectName(OWNER)).list({prefix:'reply/'})).keys()][0].slice(6);
 assert.deepEqual(await obj.operate('bridge.accepted',OWNER,{jti}),{status:'sent'});
 assert.equal(f.mail.length,1);assert.equal(f.mail[0].from,'notify@sys.3sln.example');assert.equal(f.mail[0].to,'alice@sender.example');assert.equal(f.mail[0].headers['Auto-Submitted'],'auto-replied');
 await assert.rejects(obj.operate('bridge.admit','ca401000-0000-4000-8000-000000000003',{}),{code:'forbidden'},'one owner per object');
});

test('wire pins: the core restatement of the intake contract, slot and digest equals the BindleBox protocol (import boundary kept)',async()=>{
 const W=await import('../packages/email-bridge/wire.mjs'),B=await import('../packages/bindlebox-protocol/index.mjs');
 assert.equal(W.INTAKE_CONTRACT,B.INTAKE_CONTRACT);assert.equal(W.INTAKE_SLOT,B.INTAKE_SLOT);
 const message={parts:[{mimeType:'text/plain',dataBase64url:W.base64url(new TextEncoder().encode('héllo'))}]};
 assert.equal(await W.intakeDigest(message),await B.intakeDigest(message));assert.equal(W.base64url(new Uint8Array([251,255])),B.base64url(new Uint8Array([251,255])));
});

test('Worker email handler: every outcome waits for the same response floor (timing classes, review EB-4)',async()=>{
 const waits=[],sleep=async ms=>{waits.push(ms);};
 const off=fakeEnv({config:{...CONFIG,EMAIL_BRIDGE_ENABLED:'false'}});await handleEmail(event(rawMail()),off.env,{},{EmailMessage,sleep,floorMs:60000});
 const f=fakeEnv(),ports=edge();ports.owners={admit:(o,i)=>f.env.EMAIL_BRIDGE.get(bridgeObjectName(o)).operate('bridge.admit',o,i)};
 await handleEmail(event(rawMail(),{to:`nobody@${DOMAIN}`}),f.env,{},{EmailMessage,edge:ports,sleep,floorMs:60000});
 await f.env.EMAIL_BRIDGE.get(bridgeObjectName(OWNER)).operate('bridge.configure',OWNER,{enabled:true});
 await handleEmail(event(rawMail()),f.env,{},{EmailMessage,edge:ports,sleep,floorMs:60000});
 assert.equal(waits.length,3);for(const ms of waits)assert.ok(ms>59000&&ms<=60000,String(ms));
});


test('BindleBox explicit acceptance calls the provider follow-up once; classification/rescue never sends it',async t=>{
 const clock=fakeClock(NOW),key=await bridgeKey(),box=await bindlebox(t,{clock,key}),w=await world({clock,key,call:box.call});
 box.providerLink.accepted=({jti})=>w.bridge.accepted(OWNER,jti);
 await w.enable();await w.receive(rawMail());await w.bridge.drain(OWNER);
 await box.run('intake.drain');const [item]=await box.items();assert.equal(item.state,'request');assert.equal(w.mails.length,0);
 const result=await box.run('intake.accept',{input:{id:item.id}});assert.deepEqual(result,{id:item.id,state:'accepted'});assert.equal(w.mails.length,1);
 await box.run('intake.accept',{input:{id:item.id}});assert.equal(w.mails.length,1);assert.equal((await box.store.get(`item/${item.id}`)).verifiedSender,false);
});

test('brokered delivery preserves uncertainty after account RPC serialization drops extra fault fields',async()=>{
 const {brokeredOccupant}=await import('../packages/email-bridge/engine.mjs');
 const occupant=brokeredOccupant({seat:async()=>null,call:async()=>{throw Object.assign(new Error('RPC fault'),{code:'indeterminate',status:502});}});
 await assert.rejects(occupant.deliver(OWNER,{seat:{resource:RESOURCE},tx:crypto.randomUUID(),args:{}}),e=>e.code==='indeterminate'&&e.status===502&&e.indeterminate===true);
});

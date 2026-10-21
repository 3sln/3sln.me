// BB-B7 bridge receiver: bridged public intake through the public-message-intake slot against a FAKE provider handoff
// (the provider's SMTP adapter, holding queue and auto-reply are slice BRIDGE, not built). Covers forged provenance,
// consumer/channel binding, dedup on tx, jti and ingress fingerprint, the spam tiers after custody (B2's intake),
// no backscatter, the disabled switch, the flag, and a commit whose reply is lost. Seeded: CHAOS_SEED=<seed>.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestEngine,memoryStore} from './helpers/engine.mjs';
import {fakeClock} from '../helpers/chaos.mjs';
import {ContactsDomain,ReceiveDomain} from '../../packages/bindlebox-engine/store/mailbox.mjs';
import {createBridgeProvider,BridgeReceive,BRIDGE_OPERATIONS} from '../../packages/bindlebox-engine/domains/bridge.mjs';
import {MAILBOX_OPERATIONS} from '../../packages/bindlebox-engine/operations.mjs';
import {PROVIDERS} from '../../packages/bindlebox-engine/providers.mjs';
import * as B from '../../packages/bindlebox-protocol/index.mjs';
import {NOW,SUBJECTS,principalOf,encoder} from './vectors/fixtures.mjs';

const OWNER=SUBJECTS.bob,PRINCIPAL=principalOf('bob'),PROVIDER=PRINCIPAL.issuer,RESOURCE=`https://hub.box.example/bindle/mailbox/${OWNER}`;
const MODEL={model:'spamnet',version:'3',schema:'labels-v1'};
const INVARIANT='This address receives messages through Bindle. Your email was received. The recipient reads Bindle messages in their messaging app, and email replies may not reach them. To start a conversation, get Bindle: https://3sln.example/get';
const enc=v=>B.base64url(encoder.encode(JSON.stringify(v)));
async function sign(header,claims,privateKey){const head=`${enc(header)}.${enc(claims)}`;return `${head}.${B.base64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},privateKey,encoder.encode(head))))}`;}
// RFC 9562 UUIDv5 over (feature ref, contract, entity, ingress fingerprint), as the provider bridge derives `tx`.
const NAMESPACE=Uint8Array.from('6ba7b8119dad11d180b400c04fd430c8'.match(/../g),h=>parseInt(h,16));
async function uuidv5(name){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-1',new Uint8Array([...NAMESPACE,...encoder.encode(name)]))).slice(0,16);bytes[6]=bytes[6]&15|80;bytes[8]=bytes[8]&63|128;const h=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
const classifier=()=>({inputs:[],async decide(input){this.inputs.push(structuredClone(input));return {labels:{spam:Number(/p=(0\.\d+)/.exec(input.text)?.[1]??0)},evidence:MODEL};}});

// Fake provider handoff: SMTP acceptance (owner settings only), the holding queue, provenance signing with the
// bridge key, tx derivation, the `deliver` RPC and the single invariant auto-reply, decided at acceptance from the
// sender gates alone, never from occupancy or disposition (spec §9, architecture §13).
async function fakeProvider({origin=PROVIDER,recipient=PRINCIPAL,clock,deliver,channel='email'}){
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),jwk=await crypto.subtle.exportKey('jwk',pair.publicKey),keyId=`${origin}/keys/bridge-1`;
 const queue=[],replies=[],outcomes=[],cooldown=new Set();let n=0;
 const p={origin,keyId,publicJwk:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y},queue,replies,outcomes,
  // Returns 'accepted' or the generic refusal; refused mail gets no reply and is never delivered.
  accept({handle='bob',from,text='Hello',dmarc='pass',automation=[]}){
   if(handle!=='bob')return 'refused';
   const fingerprint=`fp-${++n}`;queue.push({from,text,dmarc,automation,fingerprint,receivedAt:clock.now()});
   if(dmarc==='pass'&&!automation.includes('auto-submitted')&&!cooldown.has(from)){cooldown.add(from);replies.push({to:from,text:INVARIANT});}
   return 'accepted';
  },
  async args(mail,{jti=crypto.randomUUID(),signer=pair.privateKey,iss=origin,to=recipient,ch=channel,receivedAt=mail.receivedAt}={}){
   const message={parts:[{mimeType:'text/plain',dataBase64url:B.base64url(encoder.encode(mail.text))}]};
   const provenance=await sign({alg:'ES256',kid:keyId,typ:'bindle-intake-provenance+jwt'},{bindle:'intake-provenance',v:1,iss,channel:ch,recipient:to,receivedAt,sender:{envelopeFrom:mail.from,headerFrom:mail.headerFrom??`Sender <${mail.from}>`},dmarc:mail.dmarc,automation:mail.automation,ingressFingerprint:mail.fingerprint,normalizedDigest:await B.intakeDigest(message),jti},signer);
   return {message,provenance};
  },
  async rpc(mail,options={}){const tx=options.tx??await uuidv5(`email-bridge|${B.INTAKE_CONTRACT}|${OWNER}|${mail.fingerprint}`);return encoder.encode(JSON.stringify(B.rpcRequest({tx,resource:options.resource??RESOURCE,contract:options.contract??B.INTAKE_CONTRACT,method:'deliver',args:options.args??await p.args(mail,options)})));},
  // Holding queue drain: delivered or definitively refused mail leaves the queue; retryable failures stay.
  async drain(){for(const mail of [...queue]){try{const result=await deliver({body:await p.rpc(mail),consumer:origin,resource:RESOURCE});outcomes.push({fingerprint:mail.fingerprint,...result});queue.splice(queue.indexOf(mail),1);}catch(error){outcomes.push({fingerprint:mail.fingerprint,error:error.code});if(![429,503].includes(error.status))queue.splice(queue.indexOf(mail),1);}}},
 };
 return p;
}

async function world(t,{enabled=true,faults={},seed=Number(process.env.CHAOS_SEED??1)}={}){
 const clock=fakeClock(NOW),store=memoryStore([['owner',OWNER]]),keys=new Map(),calls={consumerKey:0,egress:0},c=classifier();
 const providerLink={async consumerKey({consumer,keyId}){calls.consumerKey++;const k=keys.get(consumer);return k&&k.keyId===keyId?{keyId,publicJwk:k.publicJwk}:null;}};
 // A trapped egress: the bridge must never send anything over any channel (no backscatter).
 const egress={fetch:async()=>{calls.egress++;throw new Error('egress forbidden');},send:async()=>{calls.egress++;throw new Error('egress forbidden');}};
 const e=createTestEngine({seed,owner:OWNER,clock,store,faults,providers:{contacts:ContactsDomain,receive:ReceiveDomain,bridge:createBridgeProvider({BINDLEBOX_ENABLED:enabled}),providerLink,classifier:c,egress,userStorage:null}});
 t.after(()=>e.dispose());
 if(enabled)await e.run('receive.configure',{input:{principal:PRINCIPAL,ingress:'https://hub.box.example/ingress'}});
 const deliver=input=>e.perform(new BridgeReceive({actor:{kind:'ingress',owner:OWNER},input}));
 const provider=await fakeProvider({clock,deliver});keys.set(provider.origin,provider);
 return {...e,clock,calls,classifier:c,provider,keys,deliver,
  system:(op,input)=>e.perform(new MAILBOX_OPERATIONS[op]({actor:{kind:'system',owner:OWNER,reason:'test'},input})),
  items:async()=>[...(await store.list({prefix:'item/'})).values()]};
}

test('registry and catalogue: bridge operations are registered and the bridge domain is a local, scoped provider',()=>{
 for(const Operation of BRIDGE_OPERATIONS)assert.equal(MAILBOX_OPERATIONS[Operation.operation],Operation);
 assert.equal(PROVIDERS.bridge.status,'local');assert.equal(PROVIDERS.bridge.scoped,true);
 assert.equal(BRIDGE_OPERATIONS.some(Operation=>Operation.deps.includes('egress')),false,'no operation can reach egress');
});

test('fake provider handoff: accepted mail is stored as an unverified channel item, tiers apply after custody, replies are invariant and only for accepted senders',async t=>{
 const w=await world(t);await w.run('intake.settings',{input:{classifierConsent:true,pin:MODEL}});
 assert.equal(w.provider.accept({from:'spam@bulk.example',text:'Win money p=0.99'}),'accepted');
 assert.equal(w.provider.accept({from:'maybe@ads.example',text:'Offer p=0.80'}),'accepted');
 assert.equal(w.provider.accept({from:'friend@ok.example',text:'Lunch? p=0.10'}),'accepted');
 assert.equal(w.provider.accept({from:'list@news.example',text:'Digest',automation:['auto-submitted']}),'accepted');
 assert.equal(w.provider.accept({handle:'nobody',from:'x@y.example'}),'refused');
 await w.provider.drain();
 assert.deepEqual(w.provider.outcomes.map(o=>o.disposition),['stored-receipt','stored-receipt','stored-receipt','stored-receipt']);
 assert.equal(w.provider.queue.length,0);
 // Every stored item is channel-origin with an unverified sender, never authored, pending classification.
 for(const item of await w.items()){assert.equal(item.origin,'channel');assert.equal(item.verifiedSender,false);assert.equal(item.author,undefined);assert.equal(item.state,'pending');assert.equal(item.notification,null);}
 const drained=await w.system('intake.drain',{});assert.equal(drained.rejected,1);assert.equal(drained.suspected,1,'a classifier result outranks header hints');
 const byFrom=Object.fromEntries((await w.items()).map(i=>[i.asserted.address,i]));
 assert.equal(byFrom['spam@bulk.example'].state,'rejected');assert.equal(byFrom['maybe@ads.example'].priority,'low');assert.equal(byFrom['friend@ok.example'].notification,'push');
 // The provider's reply was decided at acceptance, identical for every accepted sender, none for the refused one,
 // none for automated mail, and nothing the occupant did (or rejected) changed it. The occupant never replied.
 assert.deepEqual(w.provider.replies.map(r=>r.to),['spam@bulk.example','maybe@ads.example','friend@ok.example']);
 assert.equal(new Set(w.provider.replies.map(r=>r.text)).size,1);assert.equal(w.calls.egress,0);
 // The classifier saw minimized text and hints only.
 for(const input of w.classifier.inputs){assert.deepEqual(Object.keys(input).sort(),['hints','text']);assert.equal(input.text.includes('@'),false);}
});

test('forged or misbound provenance is refused before storage; consumer and channel are checked before any key lookup',async t=>{
 const w=await world(t),mail=()=>{w.provider.accept({from:`s${Math.random()}@x.example`,text:'Hi'});return w.provider.queue.pop();};
 const call=(body,consumer=w.provider.origin,resource=RESOURCE)=>w.deliver({body,consumer,resource});
 const forger=await fakeProvider({clock:w.clock,deliver:w.deliver});
 // A key the consumer never published (same claimed origin and kid).
 const forged=mail();await assert.rejects(call(await forger.rpc(forged)),{code:'not_authorized'});
 // Another consumer: not the owner's provider and not allowlisted, so no key is even looked up.
 const before=w.calls.consumerKey,other=await fakeProvider({origin:'https://evil.example',clock:w.clock,deliver:w.deliver});w.keys.set(other.origin,other);
 await assert.rejects(call(await other.rpc(mail()),other.origin),{code:'not_authorized'});assert.equal(w.calls.consumerKey,before);
 // Provenance naming another issuer than the authenticated consumer, another channel, or another recipient.
 await assert.rejects(call(await w.provider.rpc(mail(),{iss:'https://evil.example'})),{code:'not_authorized'});
 await assert.rejects(call(await w.provider.rpc(mail(),{ch:'sms'})),{code:'not_authorized'});
 await assert.rejects(call(await w.provider.rpc(mail(),{to:principalOf('carol')})),{code:'not_authorized'});
 // Digest tamper, stale receipt, framing and contract errors.
 const m=mail(),args=await w.provider.args(m);args.message.parts[0].dataBase64url=B.base64url(encoder.encode('changed'));
 await assert.rejects(call(await w.provider.rpc(m,{args})),{code:'malformed'});
 await assert.rejects(call(await w.provider.rpc(mail(),{receivedAt:w.clock.now()-8*86400000})),{code:'envelope_expired'});
 const extra=JSON.parse(new TextDecoder().decode(await w.provider.rpc(mail())));extra.extra=1;await assert.rejects(call(encoder.encode(JSON.stringify(extra))),{code:'malformed'});
 await assert.rejects(call(await w.provider.rpc(mail(),{contract:B.MAILBOX_CONTRACT})),{code:'unsupported_method'});
 await assert.rejects(call(await w.provider.rpc(mail()),w.provider.origin,'https://hub.box.example/bindle/mailbox/other'),{code:'malformed'});
 await assert.rejects(w.deliver({body:'not bytes',consumer:w.provider.origin}),{code:'malformed'});
 assert.equal((await w.items()).length,0,'nothing was stored');
 // An application consumer the owner allowed is bound to its own channel.
 await assert.rejects(w.run('bridge.configure',{input:{consumers:[{origin:PROVIDER,channel:'sms'}]}}),{code:'invalid_input'});
 await assert.rejects(w.run('bridge.configure',{input:{consumers:[{origin:other.origin,channel:'email'}]}}),{code:'invalid_input'});
 await w.run('bridge.configure',{input:{consumers:[{origin:other.origin,channel:'sms'}]}});
 const sms=await fakeProvider({origin:other.origin,clock:w.clock,deliver:w.deliver,channel:'sms'});w.keys.set(sms.origin,sms);
 assert.deepEqual(await call(await sms.rpc(mail()),sms.origin),{disposition:'stored-receipt'});
 await assert.rejects(call(await sms.rpc(mail(),{ch:'email'}),sms.origin),{code:'not_authorized'});
 assert.equal((await w.items()).length,1);
});

test('dedup on tx, jti and ingress fingerprint; the same key with other content is a conflict',async t=>{
 const w=await world(t);w.provider.accept({from:'a@one.example',text:'Once'});const mail=w.provider.queue[0];
 const body=await w.provider.rpc(mail,{jti:'mail-1'}),send=b=>w.deliver({body:b,consumer:w.provider.origin,resource:RESOURCE});
 assert.deepEqual(await send(body),{disposition:'stored-receipt'});assert.deepEqual(await send(body),{disposition:'stored-receipt'},'same tx');
 assert.deepEqual(await send(await w.provider.rpc(mail,{jti:'mail-1',tx:crypto.randomUUID()})),{disposition:'stored-receipt'},'same jti, new tx');
 // A provider crash re-signs the same accepted mail under a new jti and tx: stored once by its fingerprint.
 assert.deepEqual(await send(await w.provider.rpc(mail,{jti:'mail-1b',tx:crypto.randomUUID()})),{disposition:'stored-receipt'},'same fingerprint');
 assert.equal((await w.items()).length,1);
 await assert.rejects(send(await w.provider.rpc({...mail,text:'Other'},{jti:'mail-1c',tx:crypto.randomUUID()})),{code:'operation_conflict'});
 await assert.rejects(send(await w.provider.rpc({...mail,text:'Other'},{jti:'mail-1'})),{code:'operation_conflict'});
 assert.equal((await w.items()).length,1);
 // A lost reply after the commit is answered on retry without a second item.
 const lossy=await world(t,{faults:{mailboxStore:[{method:'transaction',when:2,mode:'after'}]}});
 lossy.provider.accept({from:'b@two.example',text:'Lost reply'});const lostBody=await lossy.provider.rpc(lossy.provider.queue[0]);
 await assert.rejects(lossy.deliver({body:lostBody,consumer:lossy.provider.origin,resource:RESOURCE}),{code:'injected_fault'});
 assert.deepEqual(await lossy.deliver({body:lostBody,consumer:lossy.provider.origin,resource:RESOURCE}),{disposition:'stored-receipt'});
 assert.equal((await lossy.items()).length,1);
});

test('no reply and no signal for rejected mail; the disabled switch refuses without storing; the flag hides everything',async t=>{
 const w=await world(t);await w.run('intake.settings',{input:{classifierConsent:true,pin:MODEL}});
 w.provider.accept({from:'spam@bulk.example',text:'p=0.999 spam'});w.provider.accept({from:'ham@ok.example',text:'p=0.01 ham'});
 const [spam,ham]=w.provider.queue,bodies=[await w.provider.rpc(spam),await w.provider.rpc(ham)];
 const first=await Promise.all(bodies.map(body=>w.deliver({body,consumer:w.provider.origin,resource:RESOURCE})));
 await w.system('intake.drain',{});
 const again=await Promise.all(bodies.map(body=>w.deliver({body,consumer:w.provider.origin,resource:RESOURCE})));
 // Identical result objects before and after the tier decision, for the rejected and the accepted mail alike.
 assert.deepEqual([...first,...again],Array(4).fill({disposition:'stored-receipt'}));
 const states=Object.fromEntries((await w.items()).map(i=>[i.asserted.address,i]));assert.equal(states['spam@bulk.example'].state,'rejected');assert.equal(states['spam@bulk.example'].notification,null);
 assert.equal(w.calls.egress,0);assert.equal(w.provider.replies.length,2,'one invariant reply per accepted sender, decided at SMTP time');
 // Owner switch off: refused, nothing stored, and the provider-side reply is unchanged by it.
 await w.run('bridge.configure',{input:{enabled:false}});assert.deepEqual(await w.run('bridge.settings'),{enabled:false,consumers:[]});
 w.provider.accept({from:'late@ok.example',text:'Late'});const late=await w.provider.rpc(w.provider.queue.at(-1));
 assert.deepEqual(await w.deliver({body:late,consumer:w.provider.origin,resource:RESOURCE}),{disposition:'refused'});
 assert.equal((await w.items()).length,2);assert.equal(w.provider.replies.length,3);
 await assert.rejects(w.run('bridge.configure',{input:{enabled:'yes'}}),{code:'invalid_input'});
 await assert.rejects(w.perform(new BridgeReceive({actor:{kind:'owner',owner:OWNER},input:{body:late,consumer:w.provider.origin}})),{code:'unauthorized'});
 const off=await world(t,{enabled:false});
 await assert.rejects(off.deliver({body:late,consumer:off.provider.origin,resource:RESOURCE}),{code:'not_found'});
 await assert.rejects(off.run('bridge.settings'),{code:'not_found'});
});


test('EB-5: forged header From cannot spend another envelope sender budget or evade its own cap',async t=>{
 const w=await world(t),deliver=async(from,headerFrom,dmarc='unknown')=>{w.provider.accept({from,dmarc});const mail={...w.provider.queue.pop(),headerFrom};return w.deliver({body:await w.provider.rpc(mail),consumer:PROVIDER,resource:RESOURCE});};
 for(let n=0;n<5;n++)assert.equal((await deliver('attacker@evil.example',`Victim ${n} <victim${n}@good.example>`)).disposition,'stored-receipt');
 await assert.rejects(deliver('attacker@evil.example','Next <next@other.example>','pass'),{code:'rate_limited'},'rotating From and DMARC assertions do not rotate the envelope budget');
 assert.equal((await deliver('victim0@good.example','Victim <victim0@good.example>','pass')).disposition,'stored-receipt','forged From did not spend the real envelope sender budget');
 assert.equal((await w.items()).length,6);
});

test('EB-5: budget keys isolate consumers/channels and collapse empty or malformed envelopes without consulting From',async()=>{
 const {intakeBudgetIdentity,chargeBudget}=await import('../../packages/bindlebox-engine/domains/receive-budget.mjs');
 const key=(consumer,channel,envelopeFrom,headerFrom)=>intakeBudgetIdentity({consumer,channel,sender:{envelopeFrom,headerFrom}}),a=key(PROVIDER,'email','A@EXAMPLE.EXAMPLE','victim@real.example');
 assert.deepEqual(a,key(PROVIDER,'email','a@example.example','someone@other.example'));assert.notEqual(a.sender,key('https://other.example','email','a@example.example','x').sender);assert.notEqual(a.domain,key(PROVIDER,'sms','a@example.example','x').domain);
 assert.deepEqual(key(PROVIDER,'email','','a@real.example'),key(PROVIDER,'email','<>','b@real.example'));
 let state;for(let n=0;n<50;n++){const request=key(PROVIDER,'email',`s${n}@bulk.example`,`victim${n}@other${n}.example`);state=chargeBudget(state,{now:NOW,plan:'paid',bytes:1,parent:'bridge',sender:request.sender,request});}
 const request=key(PROVIDER,'email','last@bulk.example','other@fresh.example');assert.throws(()=>chargeBudget(state,{now:NOW,plan:'paid',bytes:1,parent:'bridge',sender:request.sender,request}),{code:'rate_limited'},'rotating From cannot evade the envelope domain cap');
});

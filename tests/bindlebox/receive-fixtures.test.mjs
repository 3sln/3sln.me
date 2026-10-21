// Shared BB-B2 receive fixtures (no tests of its own; named to stay inside the receive* test ownership glob).
// Mailbox engines are installed on the seeded network simulator's peers; a fake links contract signs contact-link
// metas with each party's test identity key; bob and carol share one hub ingress and one edge index.
// Test-only: no provider, directory, delegation service or deployment is implied.
import {createNetwork} from './helpers/network.mjs';
import {createTestEngine,memoryStore} from './helpers/engine.mjs';
import {fakeClock} from '../helpers/chaos.mjs';
import {operations} from '../../packages/bindlebox-engine/engine.mjs';
import {ContactsDomain,ReceiveDomain} from '../../packages/bindlebox-engine/store/mailbox.mjs';
import {createEdgeIndex,flushEdgeOutbox} from '../../packages/bindlebox-engine/store/edge-index.mjs';
import {RECEIVE_OPERATIONS,ReceiveDeliver,handleIngress} from '../../packages/bindlebox-engine/domains/receive.mjs';
import {CONTACT_OPERATIONS} from '../../packages/bindlebox-engine/domains/contacts.mjs';
import {INTAKE_OPERATIONS,IntakeDeliver} from '../../packages/bindlebox-engine/domains/intake.mjs';
import {DELEGATION_OPERATIONS} from '../../packages/bindlebox-engine/domains/delegation.mjs';
import * as B from '../../packages/bindlebox-protocol/index.mjs';
import {NOW,INGRESS,generateKeys,party,world,linkPayload,initEnvelope,uuidOf,encoder} from './vectors/fixtures.mjs';

export const REGISTRY=operations(...RECEIVE_OPERATIONS,...CONTACT_OPERATIONS,...INTAKE_OPERATIONS,...DELEGATION_OPERATIONS);
export const keys=await generateKeys();
export const P={alice:await party('alice',keys),bob:await party('bob',keys),carol:await party('carol',keys)};
export {NOW,INGRESS,B,uuidOf,encoder,linkPayload,initEnvelope};
const ES={name:'ECDSA',hash:'SHA-256'};
const enc=v=>B.base64url(encoder.encode(JSON.stringify(v)));
export async function signCompact(header,claims,privateKey){const head=`${enc(header)}.${enc(claims)}`;return `${head}.${B.base64url(new Uint8Array(await crypto.subtle.sign(ES,privateKey,encoder.encode(head))))}`;}

// Fake links contract (spec §4.2) for one owner: issue/revoke/evaluate with switches and call counters.
export function linkContract(owner,clock){
 let n=0;const calls={issue:0,revoke:0,evaluate:0},state={down:new Set(),policy:()=>'eligible',consumers:new Map()};
 return {calls,state,
  async issue({type,claims}){calls.issue++;if(state.down.has('issue'))throw new Error('links down');n++;const iss=owner.principal.issuer,aud=`${iss}/users/${owner.name}/contact/${n}`,iat=Math.floor(clock.now()/1000);
   const meta=await signCompact({alg:'ES256',kid:owner.keyId,typ:'bindle-link-meta+jwt'},{bindle:'link-meta',v:1,type,iss,aud,jti:`jti-${owner.name}-${n}`,iat,exp:iat+30*86400,...claims},owner.identity.privateKey);
   return {link:`${aud}?utm_source=test&bindle_meta=${meta}`,jti:`jti-${owner.name}-${n}`};},
  async revoke(){calls.revoke++;if(state.down.has('revoke'))throw new Error('links down');return {};},
  async evaluate({principal}){calls.evaluate++;if(state.down.has('evaluate'))throw new Error('links down');return {state:state.policy(principal)};},
  async consumerKey({consumer,keyId}){const k=state.consumers.get(consumer);return k&&k.keyId===keyId?{keyId,publicJwk:k.publicJwk}:null;},
 };
}
// A bridge consumer with its own published key (spec §9).
export async function bridgeConsumer(origin='https://bob.provider.example'){
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);
 const keyId=`${origin}/keys/bridge-1`;let n=0;
 return {origin,keyId,publicJwk:{kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y},
  async args({recipient,from='spammer@spam.example',text='Buy now',dmarc='pass',automation=[],receivedAt,jti=`mail-${++n}`}){
   const message={parts:[{mimeType:'text/plain',dataBase64url:B.base64url(encoder.encode(text))}]};
   const provenance=await signCompact({alg:'ES256',kid:keyId,typ:'bindle-intake-provenance+jwt'},{bindle:'intake-provenance',v:1,iss:origin,channel:'email',recipient,receivedAt,sender:{envelopeFrom:from,headerFrom:`Sender <${from}>`},dmarc,automation,ingressFingerprint:'fp-1',normalizedDigest:await B.intakeDigest(message),jti},pair.privateKey);
   return {message,provenance};
  }};
}

export async function createWorld({seed=1,rules=[],classifier=null,userStorage=null,faults={}}={}){
 const clock=fakeClock(NOW),network=createNetwork({clock,seed,rules}),directory=world(P),edge=createEdgeIndex(memoryStore()),links={},delivered={count:0};
 const engineOf=owner=>[...network.peers.values()].find(peer=>peer.owner===owner);
 for(const [name,peer] of network.peers){
  await peer.engine.dispose();links[name]=linkContract(P[name],peer.clock);
  // A fresh directory facade per engine start, so in-memory caches do not survive a restart (revocations do).
  const providers=()=>({directory:{resolveKey:q=>directory.resolveKey(q),status:q=>directory.status(q)},delegateKeys:{current:async()=>peer.signer??P[name].signer},providerLink:links[name],classifier:peer.classifier??classifier,userStorage,contacts:ContactsDomain,receive:ReceiveDomain});
  const start=()=>createTestEngine({seed:seed+1,owner:peer.owner,clock:peer.clock,store:peer.store,providers:providers(),registry:REGISTRY,faults:peer.faults??faults[name]??{}});
  peer.engine=start();peer.restart=async()=>{peer.online=false;await peer.engine.dispose();peer.engine=start();peer.online=true;};
  peer.handler=request=>handleIngress(request,{edge,now:()=>peer.clock.now(),deliver:(owner,input)=>{delivered.count++;const target=engineOf(owner);return target.engine.perform(new ReceiveDeliver({actor:{kind:'ingress',owner},input}));}});
  await peer.engine.run('receive.configure',{input:{principal:P[name].principal,ingress:INGRESS[name]}});
 }
 const w={network,clock,directory,edge,links,delivered,peers:network.peers,
  peer:name=>network.peers.get(name),
  run:(name,op,input)=>network.peers.get(name).engine.run(op,{input}),
  system:(name,op,input)=>{const peer=network.peers.get(name),Operation=REGISTRY[op];return peer.engine.perform(new Operation({actor:{kind:'system',owner:peer.owner,reason:'test'},input}));},
  intake:(name,input)=>{const peer=network.peers.get(name);return peer.engine.perform(new IntakeDeliver({actor:{kind:'ingress',owner:peer.owner},input}));},
  flush:name=>flushEdgeOutbox(network.peers.get(name).store,edge,network.peers.get(name).owner),
  async link(name,input={}){const created=await w.run(name,'contacts.create-link',input);await w.flush(name);return {...created,meta:new URL(created.link).searchParams.get('bindle_meta')};},
  // Builds, signs and POSTs one link-kind delivery through the simulator; returns {status, json, envelope, body, request}.
  async envelope(from,to,link,{kind='one-off',body=encoder.encode(`Hello from ${from}`),operationId=uuidOf(1),createdAt=w.clock.now()-1000,subject='Hello',signer=P[from].signer,author=P[from].author,tamper,...over}={}){
   const payload=await linkPayload(P[from],P[to],{kind,body,operationId,createdAt,subject,recipient:{issuer:P[to].principal.issuer,owner:P[to].principal.subject,contactId:link.jti,resource:link.resource},...over});payload.author=author;
   let envelope=kind==='conversation-init'?await initEnvelope(P[from],P[to],[P[from],P[to]],{body,createdAt}).then(async e=>B.signEnvelope({...e.payload,recipient:payload.recipient,operationId},signer)):await B.signEnvelope(payload,signer);
   if(tamper)envelope=tamper(structuredClone(envelope));return {envelope,body};
  },
  request(to,link,{envelope,body},{authorization=`BindleLink ${link.meta}`,idempotencyKey}={}){const {contentType,bytes}=B.encodeDelivery(envelope,{body:envelope.payload.content?body:null,boundary:'bb2-boundary'});return {method:'POST',url:INGRESS[to],headers:{authorization,'content-type':contentType,...idempotencyKey?{'idempotency-key':idempotencyKey}:{}},body:bytes};},
  async post(from,to,request){const response=await network.send(from,to,request);return {status:response.status,headers:response.headers,json:await response.json()};},
  async deliver(from,to,link,options={},requestOptions={}){const built=await w.envelope(from,to,link,options),request=w.request(to,link,built,requestOptions);return {...await w.post(from,to,request),...built,request};},
  // Sender-side check of a custody receipt (spec §8.1).
  async verify(to,{envelope,body},receipt){return B.verifyReceipt(receipt,{obligation:{principal:P[to].principal,ingress:INGRESS[to],operationId:envelope.payload.operationId,payloadDigest:await B.payloadDigest(envelope),bodyDigest:envelope.payload.content?await B.sha256(crypto,body):null,kind:envelope.payload.kind},resolveKey:directory.resolveKey,status:directory.status,now:w.clock.now()});},
  items:async name=>[...(await network.peers.get(name).store.list({prefix:'item/'})).values()],
  budget:name=>network.peers.get(name).store.get('budget/v1'),
  dispose:()=>network.dispose(),
 };
 return w;
}

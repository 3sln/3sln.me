// Seeded fuzzing of the Bindle Messaging parsers (tests/helpers/chaos.mjs). Every input either parses to a value that
// re-validates or fails with a ProtocolFault carrying a §8.3 code; nothing else may escape. A failure names its seed:
// rerun with CHAOS_SEED=<seed>. Differential checks compare the strict parser with JSON.parse and JCS round trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as B from '../../packages/bindlebox-protocol/index.mjs';
import {forEachSeed} from '../helpers/chaos.mjs';

const V=JSON.parse(await readFile(new URL('./vectors/vectors.json',import.meta.url),'utf8'));
const ROUNDS=Number(process.env.BINDLEBOX_FUZZ_ROUNDS??60);
const codes=new Set(Object.keys(B.ERRORS));
const expectFault=error=>{if(!(error instanceof B.ProtocolFault)||!codes.has(error.code)||!Number.isSafeInteger(error.status))throw error;return error.code;};
const attempt=async fn=>{try{return {value:await fn()};}catch(error){return {code:expectFault(error)};}};
const bytes=v=>B.fromBase64url(v);
const encoder=new TextEncoder();
// Byte-level mutations: flip, insert, delete, duplicate a slice, truncate, splice a CRLF or a delimiter.
function mutateBytes(input,random,extra=[]){
 let b=Array.from(input);const n=1+random.int(4);
 for(let i=0;i<n;i++){
  const at=random.int(b.length+1);
  switch(random.int(7)){
   case 0:if(b.length)b[at%b.length]^=1<<random.int(8);break;
   case 1:b.splice(at,0,random.int(256));break;
   case 2:b.splice(at,1+random.int(8));break;
   case 3:{const from=random.int(b.length),len=random.int(64);b.splice(at,0,...b.slice(from,from+len));break;}
   case 4:b=b.slice(0,at);break;
   case 5:b.splice(at,0,13,10);break;
   case 6:b.splice(at,0,...(extra.length?random.pick(extra):[34,44,34]));break;
  }
 }
 return Uint8Array.from(b);
}
// Structural mutations of a JSON value: delete/add members, retype, duplicate-like collisions, deep edits.
function mutateValue(value,random,depth=0){
 const v=structuredClone(value),pick=o=>{const keys=Object.keys(o);return keys.length?keys[random.int(keys.length)]:null;};
 const walk=(node,d)=>{
  if(!node||typeof node!=='object')return;const k=pick(node);if(k===null)return;
  if(d<6&&node[k]&&typeof node[k]==='object'&&random.chance(0.6))return walk(node[k],d+1);
  switch(random.int(8)){
   case 0:delete node[k];break;
   case 1:node[`x${random.int(9)}`]=1;break;
   case 2:node[k]=typeof node[k]==='string'?node[k]+random.pick(['\u202e','\u0000',' ','A','\ud800']):'1';break;
   case 3:node[k]=random.pick([null,true,0,-1,1.5,9007199254740993,[],{},'']);break;
   case 4:if(typeof node[k]==='number')node[k]+=random.pick([1,-1,86400000,1e6]);break;
   case 5:if(Array.isArray(node[k]))node[k].push(structuredClone(node[k][0]??'x'));break;
   case 6:if(typeof node[k]==='string')node[k]=node[k].toUpperCase();break;
   case 7:node['__proto__']={polluted:true};break;
  }
 };
 walk(v,depth);return v;
}

test('strict JSON agrees with JSON.parse whenever it accepts, and JCS round-trips',async()=>{
 const seeds=V.objects.map(o=>encoder.encode(JSON.stringify(o.signed)));let accepted=0;
 await forEachSeed(ROUNDS*4,async random=>{
  const input=mutateBytes(random.pick(seeds),random,[[123,125],[92,117,100,56,48,48],[34,95,95,112,114,111,116,111,95,95,34,58,49,44]]);
  const r=await attempt(()=>B.strictJSON(input,{maxBytes:200000}));if(!r.value)return;accepted++;
  const text=new TextDecoder().decode(input);assert.deepEqual(r.value,JSON.parse(text));
  const canonical=B.jcs(r.value);assert.deepEqual(B.strictJSON(canonical,{maxBytes:200000}),r.value);assert.equal(B.jcs(JSON.parse(canonical)),canonical);
 });
 assert.ok(accepted>0,'some mutations stay valid JSON');
});

test('envelope validation and verification survive structural mutation; accepted changes never verify',async()=>{
 const parties=Object.values(V.parties),resolveKey=async({issuer,subject,keyId})=>{const p=parties.find(p=>p.principal.issuer===issuer);return p&&p.principal.subject===subject&&p.keyId===keyId?{keyId,publicJwk:p.identityPublicJwk,identityURI:p.principal.identityURI}:null;};
 const envelopes=V.objects.filter(o=>o.type==='envelope');
 await forEachSeed(ROUNDS*2,async random=>{
  const o=random.pick(envelopes),mutated=mutateValue(o.signed,random),r=await attempt(()=>B.validateEnvelope(mutated));
  if(!r.value)return;
  const same=B.jcs(B.semanticObject(r.value))===B.jcs(B.semanticObject(o.signed));
  const v=await attempt(()=>B.verifyEnvelope(mutated,{resolveKey,status:async()=>({status:'active'}),now:V.now}));
  if(!same&&v.value&&B.jcs({p:r.value.payload,k:r.value.proof.kid})!==B.jcs({p:o.signed.payload,k:o.signed.proof.kid}))assert.fail(`mutated envelope verified: ${o.name}`);
 });
});

test('multipart delivery parser: only ProtocolFaults, and accepted inputs are internally consistent',async()=>{
 const seed=bytes(V.multipart.bytesBase64url),boundary=encoder.encode('--bindlebox-vector-1');let parsed=0;
 await forEachSeed(ROUNDS*3,async random=>{
  const input=random.chance(0.1)?seed:mutateBytes(seed,random,[Array.from(boundary),Array.from(encoder.encode('\r\nContent-Type: text/plain'))]);
  const contentType=random.chance(0.9)?V.multipart.contentType:random.pick(['multipart/form-data','multipart/form-data; boundary="bindlebox-vector-1"','multipart/form-data; boundary=x; charset=utf-8','text/plain']);
  const r=await attempt(()=>B.parseDelivery(contentType,input));if(!r.value)return;parsed++;
  const {envelope,body,secret}=r.value;await B.validateEnvelope(envelope);
  if(body)assert.equal(await B.sha256(crypto,body),envelope.payload.content.sha256);
  if(secret)assert.equal(await B.secretDigest(secret),envelope.payload.record.data.secretDigest);
  // Differential: re-encoding the semantic operation parses back to the same result.
  const again=B.encodeDelivery(envelope,{body,secret,boundary:'re'});assert.deepEqual((await B.parseDelivery(again.contentType,again.bytes)).envelope,envelope);
 });
 assert.ok(parsed>0);
});

test('multicast parser: whole-request faults or per-context codes, never thrown context errors',async()=>{
 const seed=bytes(V.multicast.bytesBase64url);
 await forEachSeed(ROUNDS*3,async random=>{
  const r=await attempt(()=>B.parseMulticast(V.multicast.contentType,mutateBytes(seed,random,[Array.from(encoder.encode('{"credential":{"scheme":"BindleLink","value":"a.b.c"},"envelope":{}},'))])));
  if(!r.value)return;assert.ok(r.value.contexts.length>=1&&r.value.contexts.length<=32);
  for(const c of r.value.contexts){if(c.error)assert.ok(codes.has(c.error));else{await B.validateEnvelope(c.envelope);assert.deepEqual(c.envelope.payload.content,r.value.content);}}
 });
});

test('certificate, credential, receipt and RPC parsers reject garbage with ProtocolFaults only',async()=>{
 const certs=Object.values(V.parties).flatMap(p=>[p.certificate,p.renewedCertificate]),receipts=V.objects.filter(o=>o.type==='receipt').map(o=>o.signed);
 const rpc=encoder.encode(JSON.stringify({version:'0',tx:'00000000-0000-4000-8000-000000000001',resource:'https://hub.box.example/m/1',contract:B.MAILBOX_CONTRACT,method:'linkRevoked',args:{jti:'j1'}}));
 await forEachSeed(ROUNDS*3,async random=>{
  const cert=new TextDecoder().decode(mutateBytes(encoder.encode(random.pick(certs)),random,[[46],[61],[43]]));
  const c=await attempt(()=>B.parseDelegation(cert));if(c.value)assert.equal(c.value.claims.bindle,'key-delegation');
  await attempt(()=>B.parseCredential(new TextDecoder().decode(mutateBytes(encoder.encode(`BindleConversation ${V.objects[0].signed.payload.operationId}.${V.pairToken.token}`),random))));
  const r=await attempt(()=>B.validateReceipt(mutateValue(random.pick(receipts),random)));if(r.value)assert.equal(r.value.payload.state,'delivered');
  const q=await attempt(()=>B.parseRPC(mutateBytes(rpc,random)));if(q.value)assert.ok([B.MAILBOX_CONTRACT,B.INTAKE_CONTRACT].includes(q.value.contract));
  await attempt(()=>B.validateDescriptor(mutateValue({version:1,profiles:[B.PROFILE],ingress:'https://hub.box.example/ingress',limits:{maxParticipants:32,maxMessageBytes:1,maxEnvelopeBytes:1},kinds:['one-off'],expiresAt:V.now+1000},random),{now:V.now}));
  await attempt(()=>B.parseMulticastResults(mutateValue({results:[{index:0,state:'delivered',receipt:receipts[0]},{index:1,state:'unknown'}]},random),2));
 });
});

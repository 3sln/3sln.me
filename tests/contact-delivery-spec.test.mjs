import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,createPublicKey,verify} from 'node:crypto';
const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const vector=read('../docs/architecture/artefacts/contact-delivery-v1.vectors.json');
const schema=read('../docs/architecture/artefacts/contact-delivery-v1.schema.json');
// This vector deliberately uses only ordinary JSON values with ASCII member names.
// This fixture helper is not a complete JCS/strict-JSON wire implementation.
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const digest=b=>createHash('sha256').update(b).digest('base64url');
const semantic=envelope=>({payload:envelope.payload,proof:{alg:envelope.proof.alg,kid:envelope.proof.kid}});
const signing=envelope=>Buffer.from('bindle-contact-delivery-v1\n'+canonical({alg:envelope.proof.alg,kid:envelope.proof.kid,payload:envelope.payload}));
const valid=envelope=>verify('sha256',signing(envelope),{key:createPublicKey({format:'jwk',key:vector.publicJwk}),dsaEncoding:'ieee-p1363'},Buffer.from(envelope.proof.signature,'base64url'));

test('contact delivery fixed vector verifies exact body, canonical bytes and ES256 proof',()=>{
 assert.equal(Buffer.from(vector.bodyBase64url,'base64url').toString(),'Hello');
 assert.equal(digest(Buffer.from(vector.bodyBase64url,'base64url')),vector.envelope.payload.content.sha256);
 assert.equal(canonical({alg:vector.envelope.proof.alg,kid:vector.envelope.proof.kid,payload:vector.envelope.payload}),vector.signedCanonical);
 assert.equal(digest(signing(vector.envelope)),vector.signedBytesSha256);
 assert.equal(canonical(semantic(vector.envelope)),vector.semanticCanonical);
 assert.equal(digest(vector.semanticCanonical),vector.payloadDigest);
 assert.equal(Buffer.from(vector.envelope.proof.signature,'base64url').length,64);
 assert.equal(valid(vector.envelope),true);
 assert.equal('d' in vector.publicJwk,false);
});

test('new ECDSA signature bytes preserve replay digest; semantic mutation fails author proof',()=>{
 const other=structuredClone(vector.envelope); other.proof.signature=vector.resignedSignature;
 assert.notEqual(other.proof.signature,vector.envelope.proof.signature);
 assert.equal(valid(other),true);
 assert.equal(digest(canonical(semantic(other))),vector.payloadDigest);
 for(const mutate of [p=>p.noReply=false,p=>p.recipient.contactId='55555555-5555-4555-8555-555555555555',p=>p.subject+='!',p=>p.optionalTags=['new-tag'],p=>p.createdAt++,p=>p.content.sha256='A'.repeat(43)]){
  const changed=structuredClone(vector.envelope);mutate(changed.payload);
  assert.equal(valid(changed),false);
  assert.notEqual(digest(canonical(semantic(changed))),vector.payloadDigest);
 }
 assert.equal(verify('sha256',Buffer.from('other-purpose\n'+vector.signedCanonical),{key:createPublicKey({format:'jwk',key:vector.publicJwk}),dsaEncoding:'ieee-p1363'},Buffer.from(vector.envelope.proof.signature,'base64url')),false);
});

test('public draft contains a complete body-consistent RPC example and private schema has resolved local references',()=>{
 const md=readFileSync(new URL('../docs/spec/contact-delivery.md',import.meta.url),'utf8');
 const rpc=JSON.parse(md.match(/```json\n([\s\S]*?)\n```/)[1]);
 assert.equal(rpc.tx,rpc.args.envelope.payload.operationId);
 assert.equal(rpc.resource,rpc.args.envelope.payload.recipient.resource);
 assert.equal(rpc.args.envelope.payload.content.byteLength,Buffer.from(rpc.args.bodyBase64url,'base64url').length);
 assert.equal(rpc.args.envelope.payload.content.sha256,digest(Buffer.from(rpc.args.bodyBase64url,'base64url')));
 assert.deepEqual(schema.examples[0],{method:rpc.method,args:rpc.args});
 const walk=value=>{if(!value||typeof value!=='object')return;if(value.$ref){assert.match(value.$ref,/^#\/\$defs\//);assert.ok(schema.$defs[value.$ref.slice(8)]);}for(const v of Object.values(value))walk(v);};walk(schema);
 assert.equal(schema.additionalProperties,false);
 assert.equal(schema.$defs.envelope.additionalProperties,false);
 assert.equal(schema.$defs.args.additionalProperties,false);
});

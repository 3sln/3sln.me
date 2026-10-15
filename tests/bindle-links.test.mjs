import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseLinkQuery,parseLinkMeta,parseLinkData,strictJSON,metaDigest,verifyLinkSignature,replayDigest,LINK_LIMITS} from '../packages/messaging/bindle-links.mjs';
import {base64url} from '../packages/messaging/store.mjs';
const vector=JSON.parse(readFileSync(new URL('../docs/architecture/artefacts/bindle-links.vectors.json',import.meta.url),'utf8'));
const owner={alg:'ES256',publicJwk:vector.ownerPublicJwk},audience={alg:'ES256',publicJwk:vector.audiencePublicJwk};
const b64=value=>base64url(new TextEncoder().encode(value));
const swapPayload=(token,payload)=>{const [h,,s]=token.split('.');return `${h}.${b64(payload)}.${s}`;};
const swapHeader=(token,header)=>{const [,p,s]=token.split('.');return `${b64(header)}.${p}.${s}`;};

test('§11.1–2 fixed meta vectors parse under the strict profile and verify on exact received bytes',async()=>{
 for(const [value,claims] of [[vector.unconditionalMeta,vector.unconditionalClaims],[vector.conditionalMeta,vector.conditionalClaims]]){
  const meta=parseLinkMeta(value);assert.deepEqual(meta.claims,claims);assert.deepEqual(meta.header,{alg:'ES256',kid:'owner-key-1',typ:'bindle-link-meta+jwt'});
  assert.equal(await verifyLinkSignature(crypto,meta,owner),true);assert.equal(await verifyLinkSignature(crypto,meta,audience),false);
 }
 const data=parseLinkData(vector.response);assert.deepEqual(data.claims,vector.responseClaims);assert.equal(await verifyLinkSignature(crypto,data,audience),true);
 assert.equal(await metaDigest(crypto,parseLinkMeta(vector.conditionalMeta)),vector.md);assert.equal(vector.md.length,43);assert.equal(data.claims.md,vector.md);
 assert.equal(await replayDigest(crypto,{jti:vector.conditionalClaims.jti,iss:data.claims.iss,sub:data.claims.sub,nonce:data.claims.nonce}),vector.replayKey);
 assert.equal('d' in vector.ownerPublicJwk||'d' in vector.audiencePublicJwk,false);
});
test('§11.3 a semantically equal re-serialized payload fails exact-bytes verification',async()=>{
 const meta=parseLinkMeta(vector.reserializedMeta);assert.deepEqual(meta.claims,vector.conditionalClaims);
 assert.equal(await verifyLinkSignature(crypto,meta,owner),false);assert.notEqual(await metaDigest(crypto,meta),vector.md);
});
test('§11.4 meta/data position swap and typ/bindle mismatches are rejected by profile',()=>{
 assert.throws(()=>parseLinkData(vector.conditionalMeta),{code:'audience_malformed'});assert.throws(()=>parseLinkMeta(vector.response),{code:'link_invalid'});
 const header=JSON.stringify({alg:'ES256',kid:'owner-key-1',typ:'bindle-link-data+jwt'});assert.throws(()=>parseLinkMeta(swapHeader(vector.conditionalMeta,header)),{code:'link_invalid'});
 assert.throws(()=>parseLinkMeta(swapPayload(vector.conditionalMeta,JSON.stringify({...vector.conditionalClaims,bindle:'link-data'}))),{code:'link_invalid'});
 assert.throws(()=>parseLinkData(swapPayload(vector.response,JSON.stringify({...vector.responseClaims,bindle:'link-meta'}))),{code:'audience_malformed'});
 for(const typ of ['bindle-contact-endpoint+jwt','bindle-inbox+jwt','contact+jwt','JWT'])assert.throws(()=>parseLinkMeta(swapHeader(vector.conditionalMeta,JSON.stringify({alg:'ES256',kid:'k',typ}))),{code:'link_invalid'});
});
test('§11.5/§11.12 raw query grammar vectors: one parser decides legacy, new form and malformed',()=>{
 for(const {target,result} of vector.queries){
  if(result==='link_malformed')assert.throws(()=>parseLinkQuery(target),{code:'link_malformed'},target.slice(0,90));
  else assert.equal(parseLinkQuery(target).form,result,target.slice(0,90));
 }
 const parsed=parseLinkQuery(`/p?utm=1&bindle_meta=${vector.conditionalMeta}&bindle_data=${vector.response}#frag`);assert.deepEqual(parsed,{form:'link',meta:vector.conditionalMeta,data:vector.response});
 assert.equal(parseLinkQuery('https://h.example/p#x?bindle_meta=a.b.c').form,'none');
});
test('§2.5 length limits for meta, data and the complete target',()=>{
 const meta=`a.${'b'.repeat(LINK_LIMITS.meta-4)}.c`;assert.equal(parseLinkQuery(`/p?bindle_meta=${meta}`).meta,meta);
 assert.throws(()=>parseLinkQuery(`/p?bindle_meta=${meta}x`),{code:'link_malformed'});
 const data=`a.${'b'.repeat(LINK_LIMITS.data-4)}.c`;assert.ok(parseLinkQuery(`/p?bindle_meta=a.b.c&bindle_data=${data}`).data);assert.throws(()=>parseLinkQuery(`/p?bindle_meta=a.b.c&bindle_data=${data}x`),{code:'link_malformed'});
 assert.throws(()=>parseLinkQuery(`/p?pad=${'x'.repeat(8192)}&bindle_meta=a.b.c`),{code:'link_malformed'});
 assert.equal(parseLinkQuery(`/p?sig=${'x'.repeat(9000)}`).form,'legacy');assert.throws(()=>parseLinkQuery(`/p?sig=${'x'.repeat(18000)}`),{code:'link_malformed'});
 assert.equal(parseLinkQuery(`/p?%EF%BB%BFsig=a&bindle_meta=a.b.c`).form,'link','a BOM-prefixed name is unrelated, as in WHATWG');
});
test('§3.1 strict I-JSON: duplicates at depth, lone surrogates, unsafe numbers and trailing data',()=>{
 for(const text of ['{"a":1,"a":2}','{"a":{"b":1,"b":1}}','{"a":"\\ud800"}','{"a":"\\udc00x"}','{"a":9007199254740992}','{"a":1e400}','{"a":-0}','{"a":1} x','{"a":01}','{"a":"\u0001"}','{"a":[1,]}',"{'a':1}",'{"a":NaN}','[[[[[[[[[[1]]]]]]]]]]'])assert.throws(()=>strictJSON(text),{code:'invalid_json'},text);
 assert.deepEqual(strictJSON(' {"a":[1,true,null,"\\ud83d\\ude00\\n"],"b":{"c":-1.5e2}} '),{a:[1,true,null,'\u{1F600}\n'],b:{c:-150}});
 const proto=strictJSON('{"__proto__":{"x":1}}');assert.equal(Object.getPrototypeOf(proto),Object.prototype);assert.equal(proto.x,undefined);
});
test('§3.1 profile rejects extra header members, forbidden JOSE members, bad algs, padding and noncanonical base64url',()=>{
 for(const header of [{alg:'ES256',kid:'k',typ:'bindle-link-meta+jwt',jku:'https://x.example'},{alg:'ES256',kid:'k',typ:'bindle-link-meta+jwt',crit:[]},{alg:'none',kid:'k',typ:'bindle-link-meta+jwt'},{alg:'HS256',kid:'k',typ:'bindle-link-meta+jwt'},{alg:'ES256',typ:'bindle-link-meta+jwt'},{alg:'ES256',kid:'k',typ:'bindle-link-meta+jwt',b64:false}])
  assert.throws(()=>parseLinkMeta(swapHeader(vector.conditionalMeta,JSON.stringify(header))),{code:'link_invalid'});
 const [h,p,s]=vector.conditionalMeta.split('.');
 const last=s.at(-1),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',tweaked=alphabet[alphabet.indexOf(last)^1];
 for(const value of [`${h}.${p}.${s}=`,`${h}.${p}.${s.slice(0,-1)}${tweaked}`,`${h}.${p}`,`${h}.${p}.${s}.x`,`${h}.${p}.${s.slice(0,-4)}`])assert.throws(()=>parseLinkMeta(value),{code:'link_invalid'},value.slice(-8));
 assert.throws(()=>parseLinkData(vector.response,['EdDSA']),{code:'audience_malformed'});
 assert.throws(()=>parseLinkMeta(swapHeader(vector.conditionalMeta,JSON.stringify({alg:'ES256',kid:'k\u0085',typ:'bindle-link-meta+jwt'}))),{code:'link_invalid'});
 assert.throws(()=>parseLinkMeta(swapPayload(vector.conditionalMeta,'\ufeff'+JSON.stringify(vector.conditionalClaims))),{code:'link_invalid'},'BOM is another encoding');
});
test('§3.2 meta common members: magic, version, type URI, iss origin, aud, safe times',()=>{
 for(const changes of [{v:2},{v:'1'},{type:'http://spec.bindle.example/links/contact/v1'},{type:'https://spec.bindle.example/links/contact/v1?x'.padEnd(300,'x')},{iss:'https://links.example/'},{aud:vector.aud+'?q=1'},{aud:vector.aud+'#f'},{aud:'https://user@links.example/p'},{iat:1.5},{exp:1800000000},{iat:-1},{jti:''}]){
  assert.throws(()=>parseLinkMeta(swapPayload(vector.conditionalMeta,JSON.stringify({...vector.conditionalClaims,...changes}))),{code:'link_invalid'},JSON.stringify(changes));
 }
 for(const missing of ['bindle','v','type','iss','aud','jti','iat','exp']){const claims={...vector.conditionalClaims};delete claims[missing];assert.throws(()=>parseLinkMeta(swapPayload(vector.conditionalMeta,JSON.stringify(claims))),{code:'link_invalid'},missing);}
 for(const changes of [{md:'A'.repeat(42)},{md:'A'.repeat(43)+'='}])assert.throws(()=>parseLinkData(swapPayload(vector.response,JSON.stringify({...vector.responseClaims,...changes}))),{code:'audience_malformed'});
});
test('§11.7/§11.13 md binds one issued signing input: rotation changes it, high-s re-encoding does not',async()=>{
 const high=parseLinkMeta(vector.conditionalMetaHighS);assert.notEqual(vector.conditionalMetaHighS,vector.conditionalMeta);
 assert.equal(await verifyLinkSignature(crypto,high,owner),true);assert.equal(await metaDigest(crypto,high),vector.md);
 const rotated=parseLinkMeta(vector.rotatedMeta);assert.equal(await metaDigest(crypto,rotated),vector.rotatedMd);assert.notEqual(vector.rotatedMd,vector.md);
 assert.equal(await metaDigest(crypto,parseLinkMeta(vector.unconditionalMeta))===vector.md,false);
});

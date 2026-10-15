import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {verifyProof,thumbprint,dpopNonces,consumeProof,DPOP_TYP,EMBED_PROOF_TYP} from '../packages/federation/dpop.mjs';
import {MemoryFederationStore} from '../packages/federation/index.mjs';
import {dpopKey,b64} from './authorization-entry-helpers.mjs';
const htu='https://provider.example/oauth/token';
// One fixed verifier time: issue-time edges are computed from it, never from a second clock read.
const NOW=Date.now(),options=(extra={})=>({htm:'POST',htu,now:NOW,...extra});

test('RFC 7638 thumbprint covers only the required public members and rejects private or foreign keys',async()=>{
 const key=await dpopKey();assert.equal(await thumbprint(webcrypto,key.jwk),key.jkt);
 // RFC 9449 §6.1 example key and confirmation thumbprint.
 assert.equal(await thumbprint(webcrypto,{kty:'EC',x:'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',y:'9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',crv:'P-256'}),'0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I');
 await assert.rejects(thumbprint(webcrypto,{...key.jwk,d:b64(32)}),{code:'invalid_dpop_proof'});
 await assert.rejects(thumbprint(webcrypto,{...key.jwk,crv:'P-384'}),{code:'invalid_dpop_proof'});
 await assert.rejects(thumbprint(webcrypto,{kty:'RSA',n:'x',e:'AQAB'}),{code:'invalid_dpop_proof'});
});

test('a proof binds method, target URI, a ±60 s issue time, the key and the credential hash',async()=>{
 const key=await dpopKey(),other=await dpopKey();
 const ok=await verifyProof(webcrypto,await key.sign({htu}),options());assert.equal(ok.jkt,key.jkt);
 // Query and fragment are ignored, as RFC 9449 §4.3 requires.
 assert.equal((await verifyProof(webcrypto,await key.sign({htu:`${htu}?a=1`}),options())).jkt,key.jkt);
 const reject=async(proof,extra={})=>assert.rejects(verifyProof(webcrypto,await proof,options(extra)),{code:'invalid_dpop_proof'});
 await reject(key.sign({htu,htm:'GET'}));
 await reject(key.sign({htu:'https://provider.example/oauth/revoke'}));
 await reject(key.sign({htu:'https://evil.example/oauth/token'}));
 await reject(key.sign({htu,iat:Math.floor(NOW/1000)-61}));
 await reject(key.sign({htu,iat:Math.floor(NOW/1000)+61}));
 for(const edge of [-60,60])assert.equal((await verifyProof(webcrypto,await key.sign({htu,iat:Math.floor(NOW/1000)+edge}),options())).jkt,key.jkt,'the ±60 s window is inclusive');
 await reject(key.sign({htu,typ:'JWT'}));
 await reject(key.sign({htu,typ:EMBED_PROOF_TYP}));
 await reject(key.sign({htu,claims:{extra:1}}));
 await reject(key.sign({htu,header:{kid:'k'}}));
 await reject(key.sign({htu,jti:'short'}));
 await reject(key.sign({htu,ath:'credential-a'}),{ath:'credential-b'});
 await reject(key.sign({htu}),{ath:'credential-a'});
 assert.equal((await verifyProof(webcrypto,await key.sign({htu,ath:'credential-a'}),options({ath:'credential-a'}))).jkt,key.jkt);
 // A signature from another key over the same claims fails.
 const [head,body]=(await key.sign({htu})).split('.'),[,,foreign]=(await other.sign({htu})).split('.');await reject(Promise.resolve(`${head}.${body}.${foreign}`));
 await reject(Promise.resolve('not.a.jwt'));await reject(Promise.resolve('x'.repeat(5000)));
});

test('server nonces are purpose-bound, expire within two minutes and cannot be forged',async()=>{
 let now=NOW;const nonces=dpopNonces({secret:'s'.repeat(32),crypto:webcrypto,clock:()=>now}),other=dpopNonces({secret:'t'.repeat(32),crypto:webcrypto,clock:()=>now});
 const nonce=await nonces.issue('token'),key=await dpopKey();
 assert.ok((await verifyProof(webcrypto,await key.sign({htu,nonce}),options({now,nonce:v=>nonces.check('token',v)}))).nonceHash);
 await assert.rejects(verifyProof(webcrypto,await key.sign({htu}),options({now,nonce:v=>nonces.check('token',v)})),{code:'use_dpop_nonce'});
 await assert.rejects(nonces.check('embed',nonce),{code:'use_dpop_nonce'});
 await assert.rejects(other.check('token',nonce),{code:'use_dpop_nonce'});
 await assert.rejects(nonces.check('token',nonce.slice(0,-2)+'AA'),{code:'use_dpop_nonce'});
 now+=120001;await assert.rejects(nonces.check('token',nonce),{code:'use_dpop_nonce'});
 // Without a nonce policy, a proof carrying a nonce is malformed.
 await assert.rejects(verifyProof(webcrypto,await key.sign({htu,nonce}),options()),{code:'invalid_dpop_proof'});
});

test('consumed proofs cannot be replayed by jti or nonce',async()=>{
 const store=new MemoryFederationStore(),nonces=dpopNonces({secret:'s'.repeat(32),crypto:webcrypto,clock:()=>NOW}),key=await dpopKey(),clock=()=>NOW;
 const nonce=await nonces.issue('token'),jti=b64(18),check=v=>nonces.check('token',v);
 const first=await verifyProof(webcrypto,await key.sign({htu,nonce,jti}),options({nonce:check}));
 await store.transaction(tx=>consumeProof(tx,'dpop/',first,webcrypto,clock));
 await assert.rejects(store.transaction(tx=>consumeProof(tx,'dpop/',first,webcrypto,clock)),{code:'invalid_dpop_proof'});
 const sameNonce=await verifyProof(webcrypto,await key.sign({htu,nonce}),options({nonce:check}));
 await assert.rejects(store.transaction(tx=>consumeProof(tx,'dpop/',sameNonce,webcrypto,clock)),{code:'use_dpop_nonce'});
 assert.equal(DPOP_TYP,'dpop+jwt');
});

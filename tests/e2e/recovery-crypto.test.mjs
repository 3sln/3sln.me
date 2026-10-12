import test from 'node:test';
import assert from 'node:assert/strict';
import { argon2id } from 'hash-wasm';
import { encryptRecoveryFile, decryptRecoveryFile } from '../../packages/recovery/index.mjs';
import { launch, baseURL } from './browser.mjs';

test('real browser recovery worker interoperates with Node and authenticates public question metadata',async()=>{
 assert.ok(['localhost','127.0.0.1'].includes(new URL(baseURL).hostname));
 const payload={version:1,issuer:baseURL,handle:'crypto_fixture',recoveryToken:'non-live-browser-fixture',warning:'Fixture only.'};
 const questions=[{id:'date',type:'date',prompt:'Chosen date',hint:'Public hint'},{id:'pin',type:'pin',prompt:'Private PIN'}];
 const answers=['2000-2-29','001234'];
 const envelope=await encryptRecoveryFile(payload,questions,answers,{deriveKey:argon2id});
 const browser=await launch();
 try{
  const page=await browser.newPage();
  // Keep the real recovery document's security headers, while isolating this
  // cryptography conformance test from portal rendering and signup state.
  await page.route(`${baseURL}/recovery/restore`,async route=>{
   const response=await route.fetch();
   assert.ok(response.headers()['content-security-policy'].includes("'wasm-unsafe-eval'"));
   await route.fulfill({response,body:'<!doctype html><title>Recovery conformance</title>'});
  });
  await page.goto(`${baseURL}/recovery/restore`);
  const result=await page.evaluate(async({envelope,payload,questions,answers})=>{
   const core=await import('/packages/recovery/index.mjs');
   const deriveKey=options=>new Promise((resolve,reject)=>{
    const worker=new Worker('/recovery-kdf-worker.mjs',{type:'module'});
    const stop=()=>{clearTimeout(timer);worker.terminate();};
    const timer=setTimeout(()=>{stop();reject(new Error('Derivation timed out'));},90000);
    worker.onerror=()=>{stop();reject(new Error('Derivation failed'));};
    worker.onmessage=({data})=>{stop();data.error?reject(new Error(data.error)):resolve(data.key);};
    worker.postMessage({options});
   });
   const decrypted=await core.decryptRecoveryFile(envelope,['2000/02/29','001234'],{deriveKey});
   const browserFile=await core.encryptRecoveryFile(payload,questions,answers,{deriveKey});
   const {RECOVERY_V1_VECTOR:vector}=await import('/packages/recovery/vectors.mjs');
   const golden={format:core.RECOVERY_FORMAT,version:core.RECOVERY_VERSION,normalization:core.ANSWER_NORMALIZATION,
    questions:vector.questions,kdf:{...core.KDF_PARAMETERS,salt:vector.salt},
    cipher:{name:'AES-256-GCM',iv:vector.iv},ciphertext:vector.ciphertext};
   const goldenPayload=await core.decryptRecoveryFile(golden,vector.answers,{deriveKey});
   const vectorMatches=JSON.stringify(goldenPayload)===JSON.stringify(vector.payload)&&
    JSON.stringify(vector.questions.map((q,i)=>core.normalizeAnswer(q.type,vector.answers[i])))===JSON.stringify(vector.normalizedAnswers);
   let tamperRejected=false;
   const tampered=structuredClone(envelope);tampered.questions[0].hint='Changed public hint';
   try{await core.decryptRecoveryFile(tampered,answers,{deriveKey});}catch(error){tamperRejected=error.code==='recovery_file_authentication_failed';}
   return {decrypted,browserFile,tamperRejected,vectorMatches};
  },{envelope,payload,questions,answers});
  assert.deepEqual(result.decrypted,payload);
  assert.deepEqual(await decryptRecoveryFile(result.browserFile,answers,{deriveKey:argon2id}),payload);
  assert.equal(result.tamperRejected,true);
  assert.equal(result.vectorMatches,true);
 }finally{await browser.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentityBackup,verifyIdentityBackup,generateIdentityKeychain,createNameAssignment,verifyNameAssignment} from '../packages/recovery/identity-backup.mjs';
const authorityKeys = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const authority={kid:'provider-2026',privateKey:authorityKeys.privateKey,publicKey:authorityKeys.publicKey};
const decode=proof=>JSON.parse(Buffer.from(proof.payload,'base64url'));
async function fixture() {
  const keychain=await generateIdentityKeychain();
  const input={issuer:'https://identity.example',entity:crypto.randomUUID(),keychain,recoveryToken:'account.random-credential',warning:'Keep private.'};
  return {input,backup:await createIdentityBackup(input,authority)};
}
test('portable recovery carries a stable UUID and private keys without any name or assignment in its signed bytes',async()=>{
  const {input,backup}=await fixture();
  const verified=await verifyIdentityBackup(JSON.stringify(backup),authority,{issuer:input.issuer,entity:input.entity});
  assert.equal(verified.entity,input.entity);
  assert.equal(verified.keychain.signing.kid,input.keychain.signing.kid);
  assert.equal(verified.keychain.encryption.kid,input.keychain.encryption.kid);
  for(const value of [backup,decode(backup.proof)]){
    assert.equal(value.handle,undefined);
    assert.equal(value.nameAssignment,undefined);
    assert.equal(value.assignmentId,undefined);
  }
  assert.equal(backup.keychain.signing.privateJWK.d===input.keychain.signing.privateJWK.d,true);
  const regenerated=await generateIdentityKeychain({signing:input.keychain.signing});
  assert.equal(regenerated.signing.kid,input.keychain.signing.kid);
  assert.equal(regenerated.signing.privateJWK.d===input.keychain.signing.privateJWK.d,true);
  assert.equal(regenerated.encryption.privateJWK.d===regenerated.signing.privateJWK.d,false);
});
test('rejects tampering, name-bearing recovery schemas, cross-identity expectations and unknown authority',async()=>{
  const {input,backup}=await fixture();
  for (const mutate of [b=>b.handle='alice',b=>b.nameAssignment={},b=>b.assignmentId=crypto.randomUUID(),b=>b.entity=crypto.randomUUID(),b=>b.recoveryToken='replaced',b=>b.keychain.encryption.kid=crypto.randomUUID(),b=>b.extra=true,b=>b.proof.signature='A'.repeat(86),b=>b.warning='x'.repeat(17000)]) {
    const altered=structuredClone(backup); mutate(altered); await assert.rejects(verifyIdentityBackup(altered,authority));
  }
  await assert.rejects(createIdentityBackup({...input,handle:'alice'},authority));
  await assert.rejects(createIdentityBackup({...input,nameAssignment:{}},authority));
  await assert.rejects(verifyIdentityBackup(backup,authority,{entity:crypto.randomUUID()}));
  await assert.rejects(verifyIdentityBackup(backup,authority,{issuer:'https://other.example'}));
  const wrong=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  await assert.rejects(verifyIdentityBackup(backup,{kid:authority.kid,publicKey:wrong.publicKey}));
  await assert.rejects(verifyIdentityBackup(backup,{kid:'attacker',publicKey:authority.publicKey}));
});
test('refuses mismatched scalar/public point, reused purpose keys, malformed keys and non-v4 subjects',async()=>{
  const {input}=await fixture(); const other=await generateIdentityKeychain();
  for(const purpose of ['signing','encryption']){
    const mismatch=structuredClone(input); mismatch.keychain[purpose].privateJWK.d=other[purpose].privateJWK.d;
    await assert.rejects(createIdentityBackup(mismatch,authority));
  }
  const reused=structuredClone(input); reused.keychain.encryption={...reused.keychain.signing,kid:crypto.randomUUID()};
  await assert.rejects(createIdentityBackup(reused,authority));
  const malformed=structuredClone(input); malformed.keychain.signing.privateJWK.x+='=';
  await assert.rejects(createIdentityBackup(malformed,authority));
  await assert.rejects(createIdentityBackup({...input,entity:'not-a-uuid'},authority));
  await assert.rejects(createIdentityBackup({...input,entity:'00000000-0000-5000-8000-000000000000'},authority));
});
test('rejects misleading JWK purpose metadata and binds authority registry ID into signatures',async()=>{
  const {input,backup}=await fixture();
  for (const metadata of [{alg:'RS256'},{use:'enc'},{key_ops:['deriveBits']}]) {
    const altered=structuredClone(input); Object.assign(altered.keychain.signing.privateJWK,metadata);
    await assert.rejects(createIdentityBackup(altered,authority));
  }
  await assert.rejects(createIdentityBackup({...input,issuer:'http://identity.example'},authority));
  const relabeled=structuredClone(backup); relabeled.proof.kid='renamed';
  await assert.rejects(verifyIdentityBackup(relabeled,{...authority,kid:'renamed'}));
});
test('a separate public name certificate binds the UUID to canonical free or paid names and contains no recovery material',async()=>{
  const {input,backup}=await fixture();
  for(const handle of ['n.2a','7alice','alice-smith']){
    const claims={issuer:input.issuer,entity:input.entity,handle,assignmentId:crypto.randomUUID(),issuedAt:Date.now()};
    const certificate=await createNameAssignment(claims,authority);
    assert.equal((await verifyNameAssignment(JSON.stringify(certificate),authority,claims)).handle,handle);
    assert.equal(certificate.type,'3sln-name-assignment');
    assert.equal(certificate.entity,backup.entity);
    for(const value of [certificate,decode(certificate.proof)]){
      assert.equal(value.keychain,undefined);
      assert.equal(value.recoveryToken,undefined);
      assert.equal(JSON.stringify(value).includes(input.keychain.signing.privateJWK.d),false);
      assert.equal(JSON.stringify(value).includes(input.keychain.encryption.privateJWK.d),false);
    }
    await assert.rejects(verifyNameAssignment(certificate,authority,{entity:crypto.randomUUID()}));
    await assert.rejects(verifyNameAssignment(certificate,authority,{handle:'someone-else'}));
    await assert.rejects(verifyNameAssignment(certificate,authority,{assignmentId:crypto.randomUUID()}));
    const altered=structuredClone(certificate);altered.handle='someone-else';await assert.rejects(verifyNameAssignment(altered,authority));
    const wrongDomain=structuredClone(certificate);wrongDomain.proof=backup.proof;await assert.rejects(verifyNameAssignment(wrongDomain,authority));
    await assert.rejects(createNameAssignment({...claims,keychain:input.keychain},authority));
    await assert.rejects(createNameAssignment({...claims,recoveryToken:input.recoveryToken},authority));
    await assert.rejects(createNameAssignment({...claims,issuedAt:NaN},authority));
    await assert.rejects(createNameAssignment({...claims,handle:handle.toUpperCase()},authority));
    const wrongType=structuredClone(certificate);wrongType.type='3sln-identity-backup';await assert.rejects(verifyNameAssignment(wrongType,authority));
  }
});

test('async signing and certificate verification operate on snapshots of caller-owned input',async()=>{
  const {input}=await fixture();
  function pauseOnce(method){
    let reached,release,first=true;
    const entered=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const subtle=new Proxy(crypto.subtle,{get(target,key){if(key===method)return async(...args)=>{if(first){first=false;reached();await gate;}return target[key](...args);};return typeof target[key]==='function'?target[key].bind(target):target[key];}});
    return {crypto:{subtle,getRandomValues:crypto.getRandomValues.bind(crypto)},entered,release};
  }
  const issuer=input.issuer,entity=input.entity,signing=pauseOnce('importKey');
  const signed=createIdentityBackup(input,authority,{crypto:signing.crypto});
  await signing.entered;input.issuer='https://changed.example';input.entity=crypto.randomUUID();input.handle='forbidden-name';signing.release();
  const backup=await signed;
  assert.equal(backup.entity,entity);assert.equal(backup.issuer,issuer);assert.equal(backup.handle,undefined);
  await verifyIdentityBackup(backup,authority,{issuer,entity});
  const certificate=await createNameAssignment({issuer,entity,handle:'n.2a',assignmentId:crypto.randomUUID(),issuedAt:Date.now()},authority);
  const verification=pauseOnce('verify'),pending=verifyNameAssignment(certificate,authority,{entity},{crypto:verification.crypto});
  await verification.entered;certificate.entity=crypto.randomUUID();certificate.handle='attacker-name';certificate.recoveryToken='private-credential';verification.release();
  const verified=await pending;
  assert.equal(verified.entity,entity);assert.equal(verified.handle,'n.2a');assert.equal(verified.recoveryToken,undefined);
});

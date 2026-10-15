import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptRecoveryFile,decryptRecoveryFile,normalizeAnswer,QUESTION_TYPES,MAX_FILE_BYTES} from '../packages/recovery/index.mjs';
import {createIdentityBackup,verifyIdentityBackup,generateIdentityKeychain} from '../packages/recovery/identity-backup.mjs';
import {identityBackupPort} from '../packages/runtime/identity-backup.mjs';
import {forEachSeed} from './helpers/chaos.mjs';

// Engine-level recovery-file edge cases. The KDF is a fast keyed substitute that
// counts calls: real Argon2id is covered by the archived vector and audit suites.
function countingKDF(){const kdf={calls:0,async deriveKey({password,salt,hashLength}){kdf.calls++;return new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array([...password,...salt]))).slice(0,hashLength);}};return kdf;}
const payload={version:1,issuer:'https://identity.example',handle:'alice',recoveryToken:'account.random-recovery-credential',warning:'Keep private.'};
const questions=[{id:'pet',type:'text',prompt:'First pet',hint:''},{id:'born',type:'date',prompt:'A date',hint:''},{id:'pin',type:'pin',prompt:'PIN',hint:'digits'},{id:'phrase',type:'passphrase',prompt:'Phrase',hint:''}];
const answers=['  Rex  the   DOG ','1999/1/2','0042','exact Phrase '];
const CODES=new Set(['recovery_file_invalid','recovery_file_authentication_failed']);

const mutations=[
 (f,r)=>{const keys=Object.keys(f);delete f[r.pick(keys)];},
 f=>{f.extra=true;},
 (f,r)=>{f[r.pick(Object.keys(f))]=r.pick([null,1,'x',[],{},true]);},
 f=>{f.version=2;},f=>{f.format='3sln-recovery-v2';},f=>{f.normalization='3sln-answers-v2';},
 (f,r)=>{f.kdf[r.pick(['memoryKiB','iterations','parallelism','keyBytes'])]*=r.pick([2,1024]);},
 f=>{f.kdf.name='scrypt';},f=>{f.cipher.name='AES-128-GCM';},
 (f,r)=>{const k=r.pick(['ciphertext','salt','iv']),o=k==='ciphertext'?f:k==='salt'?f.kdf:f.cipher;const v=o[k],i=r.int(v.length);o[k]=v.slice(0,i)+(v[i]==='A'?'B':'A')+v.slice(i+1);},
 (f,r)=>{const k=r.pick(['ciphertext','salt','iv']),o=k==='ciphertext'?f:k==='salt'?f.kdf:f.cipher;o[k]=o[k].slice(0,r.int(o[k].length));},
 (f,r)=>{f.questions[r.int(f.questions.length)].prompt+=r.pick(['!','​','\u0000']);},
 (f,r)=>{f.questions[r.int(f.questions.length)].type=r.pick(['text','passphrase','pin','unknown']);},
 f=>{f.questions.push({...f.questions[0]});},f=>{f.questions=[];},
 (f,r)=>{f.questions=r.shuffle(f.questions);},
 f=>{f.ciphertext='A'.repeat(MAX_FILE_BYTES);},
];

test('recovery fuzz: every seeded mutation is refused with a typed error, and malformed files never reach the KDF',async()=>{
 const kdf=countingKDF(),file=await encryptRecoveryFile(payload,questions,answers,kdf);
 assert.deepEqual(await decryptRecoveryFile(file,answers,kdf),payload);
 await forEachSeed(60,async random=>{
  const copy=structuredClone(file);for(let i=0,n=1+random.int(2);i<n;i++)try{random.pick(mutations)(copy,random);}catch{/* a later mutation may not apply to an earlier one's result */}
  const input=random.chance(0.3)?JSON.stringify(copy).slice(0,random.int(JSON.stringify(copy).length)):copy,before=kdf.calls;
  let outcome;try{outcome=await decryptRecoveryFile(input,answers,kdf);}catch(error){outcome=error;}
  if(!(outcome instanceof Error)){assert.deepEqual(outcome,payload,'a mutation may only be a no-op, never a different payload');return;}
  if(CODES.has(outcome.code)){if(outcome.code==='recovery_file_invalid')assert.equal(kdf.calls,before,'a malformed file never invokes the KDF');return;}
  // Answers that no longer fit a tampered question type are refused before derivation.
  assert(outcome instanceof TypeError&&kdf.calls===before,`unexpected ${outcome.stack}`);
 });
});

test('truncated, empty, oversized and non-JSON recovery files are malformed before any derivation',async()=>{
 const kdf=countingKDF(),text=JSON.stringify(await encryptRecoveryFile(payload,questions,answers,kdf));kdf.calls=0;
 for(const input of ['','{',text.slice(0,-1),text.slice(0,text.length>>1),'null','[]','"file"',' '.repeat(MAX_FILE_BYTES+1),text+' '.repeat(MAX_FILE_BYTES)])
  await assert.rejects(decryptRecoveryFile(input,answers,kdf),{code:'recovery_file_invalid'});
 assert.equal(kdf.calls,0);
});

test('equivalent spellings of each answer decrypt the same file; a different answer does not',async()=>{
 const kdf=countingKDF(),file=await encryptRecoveryFile(payload,questions,answers,kdf);
 for(const variant of [['rex the dog','1999-01-02',' 0042 ','exact Phrase '],['ＲＥＸ\tthe dog','1999.01.02','００４２','exact Phrase '],['Rex The Dog　','1999-1-2','0042\n','exact Phrase ']])
  assert.deepEqual(await decryptRecoveryFile(file,variant,kdf),payload,JSON.stringify(variant));
 // Passphrases are exact apart from Unicode composition.
 for(const wrong of [['rex the dog','1999-01-02','0042','exact phrase '],['rex the dog','1999-01-02','0042','exact Phrase'],['rex the dog','1999-01-03','0042','exact Phrase '],['rex the cat','1999-01-02','0042','exact Phrase ']])
  await assert.rejects(decryptRecoveryFile(file,wrong,kdf),{code:'recovery_file_authentication_failed'});
});

// Printable, whitespace, compatibility and combining characters exercise each normalizer.
const alphabet=['a','Z','5','0','-','/','.',' ','\t',' ','　','é','é','Ａ','５','ﬁ','İ','ß','+','(',')','ǅ','Ⅻ'];
test('normalization fuzz: accepted answers are idempotent fixed points and never contain control or outer whitespace',async()=>{
 await forEachSeed(400,async random=>{
  const type=random.pick(QUESTION_TYPES),answer=Array.from({length:1+random.int(14)},()=>random.pick(alphabet)).join('');
  let first;try{first=normalizeAnswer(type,answer);}catch(error){assert(error instanceof TypeError);return;}
  assert.equal(normalizeAnswer(type,first),first,`${type} ${JSON.stringify(answer)} -> ${JSON.stringify(first)} is not stable`);
  if(type!=='passphrase')assert.equal(first,first.trim(),'typed answers have no outer whitespace');
 },{base:Number(process.env.CHAOS_SEED??1)});
});

const authorityKeys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const authority={kid:'provider-edge',privateKey:authorityKeys.privateKey,publicKey:authorityKeys.publicKey};

test('signed identity backup fuzz: no single-field mutation verifies, and expectations bind issuer and entity',async()=>{
 const keychain=await generateIdentityKeychain(),entity=crypto.randomUUID(),issuer='https://identity.example';
 const backup=await createIdentityBackup({issuer,entity,keychain,recoveryToken:'token-1',warning:'Keep private.'},authority);
 assert.equal((await verifyIdentityBackup(backup,authority,{issuer,entity})).entity,entity);
 for(const expected of [{issuer:'https://other.example'},{entity:crypto.randomUUID()}])await assert.rejects(verifyIdentityBackup(backup,authority,expected),/another identity/);
 const paths=[['version'],['issuer'],['entity'],['recoveryToken'],['warning'],['keychain','version'],['keychain','signing','kid'],['keychain','encryption','privateJWK','d'],['keychain','signing','privateJWK','x'],['proof','kid'],['proof','payload'],['proof','signature'],['proof','alg']];
 await forEachSeed(26,async random=>{
  const copy=structuredClone(backup),path=random.pick(paths),parent=path.slice(0,-1).reduce((o,k)=>o[k],copy),key=path.at(-1),value=parent[key];
  parent[key]=typeof value==='string'?random.pick([value.slice(1),value+'A',value.toUpperCase()===value?value.toLowerCase():value.toUpperCase(),'']):random.pick([value+1,String(value),null]);
  if(JSON.stringify(copy)===JSON.stringify(backup))return;
  await assert.rejects(verifyIdentityBackup(random.chance(0.5)?JSON.stringify(copy):copy,authority,{issuer,entity}),undefined,path.join('.'));
 });
 await assert.rejects(verifyIdentityBackup(JSON.stringify(backup).slice(0,-1),authority),/JSON|Unexpected|Invalid/);
 await assert.rejects(verifyIdentityBackup(JSON.stringify(backup)+' '.repeat(16*1024),authority));
});

test('identity backup port: recovery requires the same token and unrotated keys of the same account',async()=>{
 const key=await crypto.subtle.exportKey('jwk',authorityKeys.privateKey),config={APP_ORIGIN:'https://identity.example',RECOVERY_SIGNING_KEY:JSON.stringify({kid:'port-edge',privateJWK:key})};
 const chains=new Map(),accounts={get:owner=>({invoke:async({args:[id,{create}]})=>{if(!chains.has(id)&&create)chains.set(id,await generateIdentityKeychain());return structuredClone(chains.get(id));}})};
 const port=identityBackupPort({config,accounts}),alice={id:crypto.randomUUID()},bob={id:crypto.randomUUID()};
 const file=await port.issue(alice,'alice.token');await port.issue(bob,'bob.token');
 assert.equal((await port.verify(file,alice,'alice.token')).entity,alice.id);
 await assert.rejects(port.verify(file,alice,'alice.other'),/does not match/);
 await assert.rejects(port.verify(file,bob,'alice.token'),/another identity/);
 chains.set(alice.id,{...chains.get(alice.id),encryption:(await generateIdentityKeychain()).encryption});
 await assert.rejects(port.verify(file,alice,'alice.token'),/key has changed/,'a backup of rotated keys cannot overwrite the current identity');
 await assert.rejects(identityBackupPort({config:{APP_ORIGIN:config.APP_ORIGIN},accounts}).issue(alice,'t'),{code:'recovery_unavailable'});
});

// Shared BB-B6 archive fixtures (no tests of its own; named to stay inside the archive* ownership glob).
// On top of the BB-B4 conversation mesh: one object-storage/v1 resource per owner (exact absent/version conditions,
// 1 MiB objects, no listing, optional fault rules and no conditional delete), a key-holder simulator for the owner's
// identity encryption key (rotation; derive only for the current occupant's archive-purpose certificate), certificates
// that add the archive purpose, an archive engine per party on its mailbox store, and a full app switch that gives the
// owner a fresh mailbox, key, connection and ingress. Test-only: no provider, storage service or delegation service.
import {createMesh,B} from './conversations-fixtures.test.mjs';
import {createTestEngine,memoryStore} from './helpers/engine.mjs';
import {operations} from '../../packages/bindlebox-engine/engine.mjs';
import {ARCHIVE_OPERATIONS,ATTEST,createArchiveProvider} from '../../packages/bindlebox-engine/domains/archive.mjs';
import {localUnwrap,verifyUnwrapProof,MANIFEST_KEY} from '../../packages/bindlebox-engine/store/archive-writer.mjs';

export {B};
export const REGISTRY=operations(...ARCHIVE_OPERATIONS);
const failure=(code,status)=>Object.assign(new Error(code),{code,status});
const fromB64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)),toB64=b=>{let s='';for(const x of b)s+=String.fromCharCode(x);return btoa(s);};

// object-storage/v1 semantics: put needs {absent:true} or the exact version; delete needs the exact version.
export function objectStorage({maxObjectBytes=1048576,conditionalDelete=true}={}){
 const objects=new Map(),log=[],faults=[];let serial=0;
 const apply=(method,args)=>{
  const current=objects.get(args.key);
  if(method==='capabilities')return {read:true,write:true,delete:conditionalDelete,range:false,presigned:{read:false,write:false},conditionalWrites:true,maxObjectBytes};
  if(method==='get'){if(!current)throw failure('not_found',404);if(args.ifVersion!==undefined&&args.ifVersion!==current.version)throw failure('conflict',409);return {dataBase64:toB64(current.bytes),object:{key:args.key,version:current.version,size:current.bytes.length}};}
  if(method==='put'){
   if(args.condition?.absent===true?Boolean(current):args.condition?.version!==current?.version||!current)throw failure('conflict',409);
   const bytes=fromB64(args.dataBase64);if(bytes.length>maxObjectBytes)throw failure('quota_exceeded',429);
   const version=`v${++serial}`;objects.set(args.key,{bytes,version});return {object:{key:args.key,version,size:bytes.length}};
  }
  if(method==='delete'){if(!conditionalDelete)throw failure('unsupported_method',400);if(!current)throw failure('not_found',404);if(current.version!==args.version)throw failure('conflict',409);objects.delete(args.key);return {deleted:true};}
  throw failure('unsupported_method',400);
 };
 const store={objects,log,faults,before:null,
  async call(method,args){
   const n=log.filter(l=>l.method===method).length+1;log.push({method,key:args.key});if(store.before)await store.before({n,method,args});
   const rule=faults.find(f=>(!f.method||f.method===method)&&f.when({n,method,args}));
   if(rule&&rule.mode!=='after'){if(rule.once)faults.splice(faults.indexOf(rule),1);throw failure('unavailable',503);}
   const result=apply(method,structuredClone(args));
   if(rule?.mode==='after'){if(rule.once)faults.splice(faults.indexOf(rule),1);throw failure('unavailable',503);}
   return result;
  },
  bytes:key=>objects.get(key)?.bytes,
  set(key,bytes){const prior=objects.get(key);objects.set(key,{bytes,version:prior?`${prior.version}x`:`v${++serial}`});},
  manifest(){return new TextDecoder().decode(objects.get(MANIFEST_KEY).bytes);},
  payload(){return JSON.parse(new TextDecoder().decode(B.fromBase64url(this.manifest().split('.')[1])));},
  segmentKeys(){return [...objects.keys()].filter(k=>k.includes('/segments/'));},
 };
 return store;
}

// The owner's identity encryption key held by the provider. `unwrap` and `attest` answer only for an archive-purpose
// certificate of this owner whose key is the current occupant's, with a fresh proof of possession; `unwrap` returns one
// object's content key, never a raw ECDH output.
export async function keyCustody(occupant,{owner,now}){
 const keys=new Map(),calls={unwrap:0,refused:0,attest:0};let current;
 const allowed=async({delegation,proof,name,kid})=>{let c;try{c=B.parseDelegation(delegation).claims;}catch{return false;}return occupant(c)&&await verifyUnwrapProof({delegation,proof,name,kid,owner:owner(),now:now()});};
 const custody={keys,calls,
  async rotate(){const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']),{kty,crv,x,y}=await crypto.subtle.exportKey('jwk',pair.publicKey),kid=crypto.randomUUID();keys.set(kid,pair.privateKey);current={kid,publicJwk:{kty,crv,x,y}};return kid;},
  current:()=>current,
  async unwrap({delegation,proof,...header}){
   if(!await allowed({delegation,proof,name:header.name,kid:header.kid})){calls.refused++;throw failure('forbidden',403);}
   const key=keys.get(header.kid);if(!key)throw failure('not_found',404);calls.unwrap++;return localUnwrap(key,header);
  },
  async attest({delegation,proof}){calls.attest++;if(!await allowed({delegation,proof,...ATTEST})){calls.refused++;return false;}return true;},
 };
 await custody.rotate();return custody;
}

// Certificate with author, receipt and archive purposes for the party's current key, ingress and connection.
async function certifyAll(m,party,{purposes=[B.PURPOSES.author,B.PURPOSES.receipt,B.PURPOSES.archive]}={}){
 const jkt=await B.thumbprint(party.delegateJwk),iat=Math.floor(m.clock.now()/1000)-60;
 const delegation=await B.encodeDelegation({bindle:'key-delegation',v:1,iss:party.principal.issuer,sub:party.principal.subject,delegate:party.delegateJwk,jkt,purposes:[...purposes].sort(),client:{client_id:`https://${party.name}.box.example/client.json`,origin:new URL(party.ingress).origin,ingress:party.ingress},cnx:party.cnx,since:party.since,jti:`cert-${party.name}-${jkt.slice(0,8)}-${iat}-${purposes.length}`,iat,exp:iat+86400},{privateKey:party.identity.privateKey,keyId:party.keyId});
 return {privateKey:party.delegatePrivate,delegation,kid:`jkt:${jkt}`,jkt,exp:(iat+86400)*1000,ingress:party.ingress,cnx:party.cnx};
}

export async function createArchiveMesh({names=['alice','bob','carol'],limits={},storage:storageOptions={},...options}={}){
 const m=await createMesh({names,...options}),archives=new Map();
 const engineFor=(party,{store=party.store,delegateKeys}={})=>createTestEngine({owner:party.owner,clock:party.peer.clock,store,registry:REGISTRY,providers:{archive:createArchiveProvider({BINDLEBOX_ENABLED:true,ownerKeys:party.custody,limits}),userStorage:party.storage,delegateKeys,directory:{resolveKey:q=>m.directory.resolveKey(q),status:q=>m.directory.status(q)}}});
 for(const name of names){
  const party=m.party(name);party.cnx=`cnx-${name}`;party.storage=objectStorage(storageOptions);party.custody=await keyCustody(c=>c.sub===party.owner&&c.jkt===party.jkt,{owner:()=>party.principal,now:()=>m.clock.now()});
  let cached=null;
  party.current=async()=>{const jkt=await B.thumbprint(party.delegateJwk);if(!cached||cached.jkt!==jkt||cached.ingress!==party.ingress||cached.cnx!==party.cnx||cached.exp-3600000<m.clock.now())cached=await certifyAll(m,party);return cached;};
  party.archiveEngine=engineFor(party,{delegateKeys:{current:()=>party.current()}});archives.set(name,party.archiveEngine);
 }
 const a={...m,m,archives,certifyAll:(name,opts)=>certifyAll(m,m.party(name),opts),engineFor:(name,opts)=>engineFor(m.party(name),opts),
  archive:(name,op,input)=>m.party(name).archiveEngine.run(op,{input}),
  // Full app switch: a fresh mailbox store (the old one stays with the old app), a new delegate key and connection,
  // optionally a new ingress; the old key is revoked. Returns the old app's archive engine, still signing as before.
  async switchApp(name,{ingress,cnx=`${m.party(name).cnx}-next`,store=memoryStore([['owner',m.party(name).owner]])}={}){
   const party=m.party(name),oldSigner=await party.current(),oldStore=party.store;
   const old=engineFor(party,{store:oldStore,delegateKeys:{current:async()=>oldSigner}});
   party.store=store;party.peer.store=store;await party.peer.restart();party.cnx=cnx;
   const keys=await m.switchApp(name,{ingress});
   await party.archiveEngine.dispose();party.archiveEngine=engineFor(party,{delegateKeys:{current:()=>party.current()}});archives.set(name,party.archiveEngine);
   return {...keys,oldApp:old,oldStore,oldSigner};
  },
  async dispose(){for(const p of m.parties.values())await p.archiveEngine?.dispose();await m.dispose();},
 };
 return a;
}
// Every stored byte of an owner's storage, as text, to look for plaintext.
export const storedText=storage=>[...storage.objects.values()].map(o=>new TextDecoder('utf-8',{fatal:false}).decode(o.bytes)).join('\n');
export async function rejected(promise,code){try{await promise;}catch(error){if(error?.code===code)return error;throw new Error(`Expected ${code}, got ${error?.code??error}`);}throw new Error(`Expected ${code}, but it succeeded`);}

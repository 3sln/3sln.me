import {readBody} from '../store/bodies.mjs';
// BB-B6 archive and app switch (spec §6.6, §8.2, §10; architecture §8, §16, §18 retention P0). Provisional, default off:
// the provider refuses unless BINDLEBOX_ENABLED is exactly true, and nothing here is mounted by a shell yet.
//  - Checkpoint: one consistent cut of exportable mailbox rows (store/archive-writer.mjs classification), diffed against
//    a per-key shadow of what the archive already holds, written as immutable sealed segments, then published by a
//    compare-and-swap manifest signed under the archive purpose. Snapshots (compaction) replace the segment list; old
//    objects are deleted by `archive.reclaim` after a grace period. Deletions travel as delete records, so a later import
//    never resurrects a row the hot store deleted; retraction rows live as long as their conversation.
//  - Crash safety: a durable journal reserves every object name before its put; segments are reused on resume only when
//    their key range still has byte-identical lines; a manifest committed before a crash is adopted by plan ID; the
//    shadow advances only after a committed manifest (a lost advance re-archives, never skips).
//  - Writer lease: the manifest names its writer (client_id, cnx); a writer that finds another writer is fenced.
//  - App switch: the previous occupant exports a snapshot (handoff anchor {generation, digest}); the new occupant
//    verifies everything before writing, takes over the lease by CAS on the exact version it verified, imports control
//    state first, then peers, outbox summaries and items, absent-only (live rows win), resumably, then runs
//    conversations.rejoin to regain secrets (they are never archived) under its own key.
//  - Capacity reclamation: archived final send obligations shed their envelopes and bodies and leave the B3 queue
//    counters; superseded and abandoned storage objects are deleted (or reported retained where deletion is
//    unsupported).
import {Provider} from '../../../vendor/ngin/index.js';
import * as P from '../../bindlebox-protocol/index.mjs';
import {equalDigest} from '../../bindlebox-protocol/encoding.mjs';
import {MailboxAction,MailboxQuery} from '../engine.mjs';
import {fault,MailboxFault} from '../faults.mjs';
import {KEYS,actorOwner,readConfig,queueEdge,chargeUsage} from '../store/mailbox.mjs';
import * as W from '../store/archive-writer.mjs';

const te=W.encoder;
export const ARCHIVE_KEYS=Object.freeze({state:'archive/state',journal:'archive/journal',lock:'archive/lock',import:'archive/import',shadows:'archive/shadow/',shadow:b=>`archive/shadow/${b}`,gcs:'archive/gc/',gc:name=>`archive/gc/${encodeURIComponent(name)}`,resends:'archive/resend/',resend:id=>`archive/resend/${encodeURIComponent(id)}`});
const A=ARCHIVE_KEYS,SEND={queue:'bb:send:queue',message:'bb:send:message/',task:'bb:send:task/',body:'bb:send:body/'};
const FINAL=new Set(['delivered','rejected','expired','cancelled']);
const bucket=key=>{let h=0x811c9dc5;for(let i=0;i<key.length;i++){h^=key.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return (h&255).toString(16).padStart(2,'0');};
const hash=line=>W.digest(te.encode(line));
const sameWriter=(w,s)=>w.client_id===s.client_id&&w.cnx===s.cnx;
const principalOf=p=>({issuer:p.issuer,subject:p.subject});
const disabled=()=>fault('not_found','BindleBox is disabled.',404);

// Owner-bound handle over the mailbox store plus the archive's ports. `ownerKeys` is composition-supplied:
// {current() -> {kid, publicJwk}} (the owner's identity encryption public key), {unwrap({kid, epk, name, owner, wiv,
// wct, delegation, proof}) -> that object's 32-byte content key} and {attest({delegation, proof}) -> true}. The holder
// answers only for the current occupant's archive-purpose key, proven by a fresh signature (W.verifyUnwrapProof); the
// certificate alone is public (review BB6-S1, S2, S10).
export function createArchiveProvider({BINDLEBOX_ENABLED=false,ownerKeys=null,limits={}}={}){
 const caps={...W.ARCHIVE_LIMITS,...limits};
 for(const [k,v] of Object.entries(caps))if(!Number.isSafeInteger(v)||v<1)throw new TypeError(`Invalid archive limit ${k}`);
 if(caps.segmentBytes>W.ARCHIVE_LIMITS.segmentBytes)throw new TypeError('Archive segments must fit one storage object');
 return class ArchiveProvider extends Provider {
  static deps=['mailboxStore','clock','userStorage','delegateKeys','directory'];
  #deps;#held=new WeakMap();
  constructor(deps){super();this.#deps=deps;}
  async obtain({actor}={}){
   const owner=actorOwner(actor,['owner','system']),resources={},obtained=[];
   try{
    for(const name of this.constructor.deps){resources[name]=await this.#deps[name].obtain();obtained.push(name);}
    if(await resources.mailboxStore.get(KEYS.owner)!==owner)throw new MailboxFault('forbidden','Mailbox owner mismatch.',403);
    const handle=Object.freeze({owner,kind:actor.kind,store:resources.mailboxStore,clock:resources.clock,userStorage:resources.userStorage,delegateKeys:resources.delegateKeys,directory:resources.directory,ownerKeys,caps,enabled:BINDLEBOX_ENABLED===true});
    this.#held.set(handle,{resources,obtained});return handle;
   }catch(error){for(const name of obtained.reverse())await this.#deps[name].release(resources[name]);throw error;}
  }
  async release(handle){const held=this.#held.get(handle);if(!held)return;this.#held.delete(handle);for(const name of held.obtained.reverse())await this.#deps[name].release(held.resources[name]);}
 };
}
export const ARCHIVE_PROVIDERS={archive:createArchiveProvider()};

// One snapshot of the delegate key, which must carry the archive purpose for this principal and certified ingress.
// The provider certifies that purpose only to the current messaging occupant (spec §3.2).
async function archiveSigner(h,config,now){
 const fail=()=>fault('signing_unavailable','Archive signing is unavailable. Reconnect BindleBox.',503);
 let s;try{s=await h.delegateKeys?.current?.();}catch{s=undefined;}
 if(!s||typeof s!=='object')fail();let jws;try{jws=P.parseDelegation(s.delegation);}catch{fail();}
 const c=jws.claims,skew=P.LIMITS.clockSkewMs;
 if(s.kid!==`jkt:${c.jkt}`||c.iss!==config.principal.issuer||c.sub!==config.principal.subject||!c.purposes.includes(P.PURPOSES.archive)||c.client.ingress!==config.ingress||now<c.iat*1000-skew||now>c.exp*1000+skew)fail();
 return Object.freeze({kid:s.kid,privateKey:s.privateKey,delegation:s.delegation,jkt:c.jkt,cnx:c.cnx,client_id:c.client.client_id});
}
async function ownerKey(h){
 let k;try{k=await h.ownerKeys?.current?.();}catch{k=undefined;}
 if(!k||typeof k.kid!=='string'||!k.publicJwk)fault('archive_keys_unavailable','Your encryption key is unavailable.',503);return {kid:k.kid,publicJwk:k.publicJwk};
}
function unwrapper(h,signer){
 if(typeof h.ownerKeys?.unwrap!=='function')fault('archive_keys_unavailable','Your encryption key is unavailable.',503);
 return async header=>h.ownerKeys.unwrap({...header,delegation:signer.delegation,proof:await W.unwrapProof(signer,{name:header.name,kid:header.kid,at:h.clock.now()})});
}
export const ATTEST={name:W.MANIFEST_KEY,kid:'takeover'};
async function attest(h,signer){
 let ok=false;try{ok=typeof h.ownerKeys?.attest==='function'&&await h.ownerKeys.attest({delegation:signer.delegation,proof:await W.unwrapProof(signer,{...ATTEST,at:h.clock.now()})})===true;}catch{ok=false;}
 if(!ok)fault('archive_not_occupant','Only your current messaging app can take over your archive.',403);
}
// One archive writer at a time per mailbox (alarm and owner may race); a crashed holder's lock expires. Every journal,
// commit and import transaction re-checks and extends the lease, so an expired holder can no longer write (BB6-S11).
const guards=new WeakMap();
const guard=(h,tx)=>guards.get(h)?.(tx);
async function locked(h,work){
 const token=globalThis.crypto.randomUUID(),now=h.clock.now();
 await h.store.transaction(async tx=>{const l=await tx.get(A.lock);if(l&&l.until>now)fault('archive_busy','Your archive is being written. Try again shortly.',409);await tx.put(A.lock,{token,until:now+h.caps.lockMs});});
 guards.set(h,async tx=>{const l=await tx.get(A.lock);if(l?.token!==token)fault('archive_busy','Your archive is being written elsewhere.',409);await tx.put(A.lock,{token,until:h.clock.now()+h.caps.lockMs});});
 try{return await work();}finally{guards.delete(h);await h.store.transaction(async tx=>{if((await tx.get(A.lock))?.token===token)await tx.delete(A.lock);}).catch(()=>{});}
}
async function readManifest(h,storage,config,trusted){
 const got=await storage.get(W.MANIFEST_KEY);if(!got)return null;
 return {...await W.verifyManifest(W.utf8(got.bytes),{owner:config.principal,directory:h.directory,now:h.clock.now(),trusted:trusted.filter(Boolean)}),version:got.version};
}
// A consistent cut of exportable rows (one transaction), hashed outside it.
async function cut(h){
 const {rows,shadow}=await h.store.transaction(async tx=>{
  const rows=[];for(const [key,value] of await tx.list({prefix:''}))if(!key.startsWith('archive/'))rows.push([key,value]);
  const shadow=new Map();for(const [,b] of await tx.list({prefix:A.shadows}))for(const [k,v] of Object.entries(b))shadow.set(k,v);
  return {rows,shadow};
 });
 const entries=[];
 for(const [key,value] of rows){const line=W.lineOf(key,value);if(line===null)continue;entries.push({key,line,phase:W.classify(key).phase,hash:await hash(line)});}
 entries.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);return {entries,shadow};
}
const segmentEntry=s=>({name:s.name,sha256:s.sha256,bytes:s.bytes,count:s.count,kind:s.kind,keyId:s.keyId});
const localSegment=(s,version=null)=>({...segmentEntry(s),version:s.version??version,blobs:s.blobs??[]});
const objectsOf=segments=>new Set(segments.flatMap(s=>[s.name,...(s.blobs??[]).map(b=>b.name)]));
async function retire(tx,names,versions,after){for(const name of names)await tx.put(A.gc(name),{name,version:versions.get(name)??null,after,attempts:0});}
const versionsOf=segments=>new Map(segments.flatMap(s=>[[s.name,s.version??null],...(s.blobs??[]).map(b=>[b.name,b.version??null])]));
async function journalUpdate(h,id,update){return h.store.transaction(async tx=>{await guard(h,tx);const j=await tx.get(A.journal);if(!j||j.id!==id)fault('archive_busy','The archive plan changed.',409);update(j);await tx.put(A.journal,j);return j;});}

// Seals one planned segment (and blob parts of any line larger than a segment). Every object name is reserved in the
// journal before its put, so an interrupted plan leaves no unrecorded object.
async function uploadSegment(h,storage,config,key,planned,kind,journal){
 const physical=[],blobs=[],reserve=name=>journalUpdate(h,journal.id,j=>{j.objects=[...new Set([...j.objects,name])];});
 for(const line of planned.lines){
  if(te.encode(line).length<=h.caps.segmentBytes){physical.push(line);continue;}
  const {t,k}=JSON.parse(line),refs=[];
  for(const part of W.blobParts(line,{segmentBytes:h.caps.segmentBytes})){
   const name=W.objectName('blob'),sealed=await W.sealObject(part,{key,name,owner:config.principal,kind:'blob'});
   await reserve(name);const version=await storage.put(name,sealed,{absent:true});refs.push({name,sha256:await W.digest(sealed),bytes:sealed.length});blobs.push({name,version});
  }
  physical.push(JSON.stringify({t,k,blob:refs}));
 }
 const name=W.objectName('segment'),sealed=await W.sealObject(te.encode(physical.join('\n')),{key,name,owner:config.principal,kind:'segment'});
 await reserve(name);const version=await storage.put(name,sealed,{absent:true});
 const entry={name,sha256:await W.digest(sealed),bytes:sealed.length,count:planned.lines.length,kind,keyId:key.kid,first:planned.first,last:planned.last,digest:planned.digest,control:planned.control,blobs,version};
 await journalUpdate(h,journal.id,j=>{j.segments.push(entry);});return entry;
}

async function checkpoint(h,{mode='auto',handoff=false}={}){
 if(!h.enabled)disabled();
 const store=h.store,config=await readConfig(store),storage=W.storageClient(h.userStorage),signer=await archiveSigner(h,config,h.clock.now()),key=await ownerKey(h);
 return locked(h,async()=>{
  let state=await store.get(A.state)??{generation:0,segments:[],digest:null};
  if(state.fenced)fault('archive_fenced','Another messaging app now writes your archive.',409);
  const job=await store.get(A.import);if(job&&!job.done)fault('archive_busy','Your archive is being imported.',409);
  let journal=await store.get(A.journal);
  // A mailbox that never wrote or imported must not judge (or overwrite) an archive already in storage.
  if(!state.generation&&await storage.get(W.MANIFEST_KEY))fault('archive_exists','Your storage already holds an archive. Import it first.',409);
  const manifest=await readManifest(h,storage,config,[state.digest]);
  const rolledBack=()=>fault('archive_rolled_back','Your storage holds an older or unverifiable copy of your archive.',409);
  if(manifest&&sameWriter(manifest.payload.writer,signer)&&(manifest.payload.generation<state.generation||(manifest.payload.generation>state.generation&&!manifest.active)))rolledBack();
  if(manifest&&!sameWriter(manifest.payload.writer,signer)){
   // Fenced only by a newer manifest from an active key; an older or revoked-key manifest is a rollback, which is
   // reported without changing anything (BB6-S5).
   if(!state.generation)fault('archive_exists','Your storage already holds an archive. Import it first.',409);
   if(manifest.payload.generation<=state.generation||!manifest.active)rolledBack();
   await store.transaction(async tx=>{const s=await tx.get(A.state);await tx.put(A.state,{...s,fenced:true,fencedAt:h.clock.now()});});
   fault('archive_fenced','Another messaging app now writes your archive.',409);
  }
  const now0=h.clock.now();
  if(manifest&&manifest.payload.generation!==state.generation){
   // A manifest this mailbox committed before losing the local commit is adopted by plan ID (the shadow is not
   // advanced, so its changes are archived again); any other of our own manifests replaces local state and forces
   // a snapshot.
   const ours=journal&&manifest.payload.plan===journal.id&&manifest.payload.generation===journal.generation;
   const segments=manifest.payload.segments.map(s=>{const known=[...state.segments,...(ours?journal.segments:[])].find(x=>x.name===s.name);return localSegment(known??s,null);});
   await store.transaction(async tx=>{
    if(journal){const keep=objectsOf(segments);await retire(tx,journal.objects.filter(n=>!keep.has(n)),new Map(),now0);await tx.delete(A.journal);}
    state={...state,generation:manifest.payload.generation,version:manifest.version,digest:manifest.digest,base:manifest.payload.base,segments,writer:manifest.payload.writer,leaseUntil:manifest.payload.leaseUntil,shadowInvalid:ours?Boolean(state.shadowInvalid):true};
    await tx.put(A.state,state);
   });
   journal=null;
  }
  if(!manifest&&state.generation>0)state={...state,shadowInvalid:true};
  if(journal&&journal.base!==(manifest?.payload.generation??0)){
   await store.transaction(async tx=>{await retire(tx,journal.objects,new Map(),now0);await tx.delete(A.journal);});journal=null;
  }
  const deltas=manifest?manifest.payload.segments.filter(s=>s.kind==='delta').length:0;
  const snapshot=mode==='snapshot'||handoff||!manifest||Boolean(state.shadowInvalid)||deltas>=h.caps.deltasBeforeCompaction||manifest.payload.segments.length>=h.caps.segments-64;
  const {entries,shadow}=await cut(h),present=new Set(entries.map(e=>e.key));
  let work=entries;
  if(!snapshot){
   work=entries.filter(e=>shadow.get(e.key)?.h!==e.hash);
   for(const [k,s] of shadow)if(!present.has(k)&&W.classify(k)){const line=JSON.stringify({t:W.classify(k).type,k,d:1});work.push({key:k,line,phase:W.classify(k).phase,hash:null,deleted:true});}
   work.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
   if(!work.length&&manifest.payload.leaseUntil-h.clock.now()>h.caps.leaseMs/2)return {kind:'none',generation:state.generation,records:0,segments:0,reused:0};
  }
  const kind=snapshot?'snapshot':'delta',base=manifest?.payload.generation??0,plans=await W.plan(work,{segmentBytes:h.caps.segmentBytes});
  if(!journal||journal.kind!==kind||journal.handoff!==handoff){
   journal=await store.transaction(async tx=>{const prior=await tx.get(A.journal);if(prior)await retire(tx,prior.objects,new Map(),now0);const j={id:globalThis.crypto.randomUUID(),kind,handoff,base,generation:Math.max(base,state.generation)+1,segments:[],objects:[],startedAt:now0};await tx.put(A.journal,j);return j;});
  }
  // Resume: reuse uploaded segments while their ranges still hold identical lines; drop the rest of the old plan.
  const uploaded=[];let reused=0,i=0;
  for(;i<plans.length&&i<journal.segments.length;i++){const p=plans[i],s=journal.segments[i];if(s.first!==p.first||s.last!==p.last||s.digest!==p.digest)break;uploaded.push(s);reused++;}
  if(journal.segments.length>reused){
   const stale=journal.segments.slice(reused);journal=await journalUpdate(h,journal.id,j=>{j.segments=j.segments.slice(0,reused);});
   await store.transaction(tx=>retire(tx,stale.flatMap(s=>[s.name,...s.blobs.map(b=>b.name)]),versionsOf(stale),now0));
  }
  for(;i<plans.length;i++){uploaded.push(await uploadSegment(h,storage,config,key,plans[i],kind,journal));}
  const now=h.clock.now(),generation=journal.generation,prior=snapshot?[]:state.segments,keepNames=objectsOf([...prior,...uploaded]);
  // Objects awaiting deletion travel in the manifest, so a new occupant can reclaim what this one left behind.
  const pendingGc=[...(await store.list({prefix:A.gcs})).values()].filter(g=>!g.retained).map(g=>({name:g.name,after:g.after}));
  const retiring=[...pendingGc,...(snapshot?[...objectsOf(state.segments)].map(name=>({name,after:now+h.caps.gcGraceMs})):[]),...journal.objects.map(name=>({name,after:now}))];
  const retired=[...new Map(retiring.filter(r=>!keepNames.has(r.name)).map(r=>[r.name,r])).values()].slice(0,W.ARCHIVE_LIMITS.retired);
  const payload={version:1,profile:P.PROFILE,owner:principalOf(config.principal),generation,base:snapshot?generation:manifest.payload.base,previous:manifest?.digest??null,
   writer:{client_id:signer.client_id,cnx:signer.cnx,jkt:signer.jkt},leaseUntil:now+h.caps.leaseMs,writtenAt:now,controlGeneration:snapshot||uploaded.some(s=>s.control)?generation:manifest.payload.controlGeneration,
   handoff,plan:journal.id,takeover:null,segments:[...prior.map(segmentEntry),...uploaded.map(segmentEntry)],retired,delegation:signer.delegation};
  const compact=await W.signManifest(payload,signer),bytes=te.encode(compact),manifestDigest=await W.digest(bytes);
  let version;
  try{version=await storage.put(W.MANIFEST_KEY,bytes,manifest?{version:manifest.version}:{absent:true});}
  catch(error){if(error?.code==='conflict')fault('archive_conflict','Your archive changed while it was being written. Try again.',409);throw error;}
  await store.transaction(async tx=>{
   await guard(h,tx);const segments=[...prior,...uploaded.map(s=>localSegment(s))],keep=objectsOf(segments);
   if(snapshot)await retire(tx,[...objectsOf(state.segments)].filter(n=>!keep.has(n)),versionsOf(state.segments),now+h.caps.gcGraceMs);
   await retire(tx,journal.objects.filter(n=>!keep.has(n)&&!objectsOf(state.segments).has(n)),new Map(),now);
   await tx.put(A.state,{generation,version,digest:manifestDigest,base:payload.base,segments,writer:payload.writer,leaseUntil:payload.leaseUntil,lastCheckpointAt:now,handoff,fenced:false,shadowInvalid:false,imported:state.imported??null});
   await tx.delete(A.journal);
   // The shadow records exactly what this manifest holds.
   const buckets=new Map();const get=async b=>{if(!buckets.has(b))buckets.set(b,snapshot?{}:await tx.get(A.shadow(b))??{});return buckets.get(b);};
   if(snapshot)for(const [k] of await tx.list({prefix:A.shadows}))await tx.delete(k);
   for(const e of work){const b=await get(bucket(e.key));if(e.deleted)delete b[e.key];else b[e.key]={h:e.hash,t:W.classify(e.key).type};}
   for(const [b,value] of buckets){if(Object.keys(value).length)await tx.put(A.shadow(b),value);else await tx.delete(A.shadow(b));}
  });
  return {kind,generation,digest:manifestDigest,records:work.length,segments:uploaded.length,reused,bytes:uploaded.reduce((n,s)=>n+s.bytes,0),handoff};
 });
}

// Reads and verifies every segment (and blob) of a manifest before anything is applied: ciphertext size and digest from
// the signed manifest, the sealed header's name/owner/kind, the declared key, line count, key range and order. Later
// segments override earlier ones; delete records remove keys. Returns the surviving records.
async function readAll(storage,owner,segments,unwrap,blobs=new Map()){
 const map=new Map(),bad=()=>fault('archive_corrupt','The archive is damaged or was changed outside BindleBox.',422);
 for(const s of segments){
  const got=await storage.get(s.name);if(!got)fault('archive_corrupt','Part of your archive is missing.',422);
  if(got.bytes.length!==s.bytes||!equalDigest(await W.digest(got.bytes),s.sha256))bad();
  const opened=await W.openObject(got.bytes,{name:s.name,owner,kind:'segment',unwrap});if(opened.kid!==s.keyId)bad();
  const lines=W.utf8(opened.plain).split('\n');if(lines.length!==s.count)bad();
  let prev=null;
  for(const raw of lines){
   let line=raw,ref;try{ref=P.strictJSON(raw,{maxBytes:W.ARCHIVE_LIMITS.objectBytes,maxDepth:72});}catch{bad();}
   if(ref&&Array.isArray(ref.blob)){
    if(Object.keys(ref).sort().join(',')!=='blob,k,t'||!ref.blob.length||ref.blob.length>64)bad();const parts=[];
    for(const b of ref.blob){if(typeof b?.name!=='string'||!/^bindlebox\/v1\/blobs\/[A-Za-z0-9_-]{16,128}$/.test(b.name)||typeof b.sha256!=='string')bad();const part=await storage.get(b.name);blobs.set(s.name,[...(blobs.get(s.name)??[]),{name:b.name,version:part?.version??null}]);if(!part||part.bytes.length!==b.bytes||!equalDigest(await W.digest(part.bytes),b.sha256))bad();parts.push((await W.openObject(part.bytes,{name:b.name,owner,kind:'blob',unwrap})).plain);}
    const joined=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){joined.set(p,at);at+=p.length;}line=W.utf8(joined);
   }
   const rec=W.parseLine(line);
   if(ref?.blob&&(rec.key!==ref.k||ref.t!==rec.type))bad();
   if((prev!==null&&rec.key<=prev)||(s.kind==='snapshot'&&rec.deleted))bad();prev=rec.key;
   map.set(rec.key,rec);
  }
 }
 return [...map.values()].filter(r=>!r.deleted).sort((a,b)=>a.phase-b.phase||(a.key<b.key?-1:a.key>b.key?1:0));
}

// Writes one batch of imported rows. Live rows win (absent-only), so traffic admitted during an import, or a resumed
// import, never rolls a row back; counters take the maximum. Imported parents republish to the edge index; imported
// hot bodies are charged to the hot allowance; unresolved obligations of the previous occupant are listed for resend.
async function applyBatch(tx,rows,counts){
 for(const r of rows){
  const existing=await tx.get(r.key);
  if(W.COUNTERS.has(r.key)){if(typeof r.value==='number'&&(existing===undefined||r.value>existing))await tx.put(r.key,r.value);continue;}
  if(existing!==undefined){counts.kept=(counts.kept??0)+1;continue;}
  await tx.put(r.key,r.value);counts[r.type]=(counts[r.type]??0)+1;
  if(r.key.startsWith('parent/')&&r.value?.iss&&r.value.jti)await queueEdge(tx,{iss:r.value.iss,jti:r.value.jti,claimsDigest:r.value.claimsDigest,revoked:r.value.revoked===true});
  if(r.key.startsWith('item/')&&Number.isSafeInteger(r.value?.hot)&&r.value.hot>0)await chargeUsage(tx,{bytes:r.value.hot});
  if(r.key.startsWith(SEND.task)&&r.value?.resend){const id=r.value.messageId;const prior=await tx.get(A.resend(id));await tx.put(A.resend(id),{messageId:id,kind:r.value.kind??null,recipients:[...new Map([...(prior?.recipients??[]),r.value.principal].filter(Boolean).map(p=>[`${p.issuer}|${p.subject}`,p])).values()],at:r.value.createdAt??null});}
  if(r.key.startsWith('conv/op/')&&r.value?.unsent)await tx.put(A.resend(r.value.operationId),{messageId:r.value.operationId,kind:'conversation-record',conversationId:r.value.cid,eventId:r.value.eventId,recipients:[],at:r.value.createdAt??null});
 }
}

// Cryptographic provenance is checked again before the first imported row is committed. Historical
// certificates are evaluated at signing time; redacted/legacy rows retain an explicit unverified marker.
async function verifyImported(records,directory,now,userStorage,owner){
 const rows=new Map(records.map(r=>[r.key,r.value])),same=(a,b)=>P.jcs(a??null)===P.jcs(b??null),bad=()=>{throw new Error();};
 for(const r of records){
  const v=r.value;if(!v||typeof v!=='object'||!(r.key.startsWith('item/')||r.key.startsWith('conv/event/')))continue;
  v.imported={verified:false,at:now};let content=v.content;
  try{
   if(v.envelope&&!v.secretRedacted){
    const verified=await P.verifyEnvelope(v.envelope,{resolveKey:q=>directory.resolveKey(q),status:q=>directory.status(q),now,atOnly:true}),p=v.envelope.payload,a=verified.author;
    if(v.payloadDigest&&v.payloadDigest!==verified.payloadDigest||v.eventId&&v.eventId!==verified.eventId)bad();
    if(!same(v.author?.principal,{issuer:a.principal.issuer,subject:a.principal.subject})&&!same(v.author?.principal,a.principal)||v.author?.keyId!==a.keyId||v.author?.jkt!==a.jkt)bad();
    if(v.createdAt!==p.createdAt||!same(v.content,p.content))bad();content=p.content;
    if(r.key.startsWith('conv/event/')){
     const rec=p.record;if(!rec||r.key!==`conv/event/${rec.conversationId}/${verified.eventId}`||v.own!==(a.principal.issuer===owner.issuer&&a.principal.subject===owner.subject))bad();
     for(const k of ['type','counter','stream','previous','parents','epoch'])if(!same(v[k],rec[k]))bad();if(!same(v.target,rec.target))bad();
    }else if(v.kind!==p.kind||v.operationId!==p.operationId||v.subject!==p.subject||r.key!==`item/${await P.sha256(globalThis.crypto,P.replayKey(v.envelope))}`)bad();
    v.imported.verified=true;
   }else if(v.signedGenesis){
    const g=await P.validateGenesis(v.signedGenesis),p=g.payload;
    const a=await P.authenticate(g,{domain:P.DOMAINS.genesis,principal:p.creator.principal,keyId:p.creator.keyId,purpose:P.PURPOSES.author,at:p.createdAt,atOnly:true,resolveKey:q=>directory.resolveKey(q),now,required:false});
    if(v.type!=='genesis'||await P.genesisDigest(g)!==v.eventId||r.key!==`conv/event/${p.conversationId}/${v.eventId}`||v.createdAt!==p.createdAt||!same(v.content,p.content)||!same(v.author?.principal,{issuer:a.principal.issuer,subject:a.principal.subject})||v.author?.keyId!==a.keyId||v.author?.jkt!==a.jkt||v.own!==(a.principal.issuer===owner.issuer&&a.principal.subject===owner.subject))bad();
    content=p.content;v.imported.verified=true;
   }
   if(content){
    const body=r.key.startsWith('conv/event/')?rows.get(r.key.replace('conv/event/','conv/body/')):v.bodyRef?.storage==='user'?await readBody(userStorage,v.bodyRef):rows.get('body/'+v.id);
    if(v.imported.verified&&(body===undefined||body===null)||body!==undefined&&body!==null&&!same(await P.contentDescriptor(content.mimeType,Uint8Array.from(body)),content))bad();
   }
  }catch{fault('archive_invalid','An imported envelope or its body could not be verified.',422);}
 }
}

async function importArchive(h,{expect,unanchored=false}={}){
 if(!h.enabled)disabled();
 // The switch flow passes the previous app's export anchor; an unanchored import (a restore with no handoff) needs the
 // owner's explicit confirmation, since storage could replay an older genuine manifest (BB6-S4).
 if(expect===undefined&&unanchored!==true)fault('archive_anchor_required','Confirm which archive to import.',409);
 if(expect!==undefined&&(!expect||!Number.isSafeInteger(expect.generation)||typeof expect.digest!=='string'||expect.digest.length!==43))fault('invalid_input','Choose a valid handoff.',400);
 const store=h.store,config=await readConfig(store),storage=W.storageClient(h.userStorage),signer=await archiveSigner(h,config,h.clock.now()),unwrap=unwrapper(h,signer);
 return locked(h,async()=>{
  let job=await store.get(A.import);const state=await store.get(A.state);
  if(job?.done){await store.transaction(tx=>tx.delete('archive/hold'));return job.result;}
  if(!job&&state?.generation)fault('archive_conflict','This mailbox already writes an archive.',409);
  await store.transaction(tx=>tx.put('archive/hold',true));
  const got=await storage.get(W.MANIFEST_KEY);if(!got)fault('archive_missing','No archive was found in your storage.',404);
  const m=await W.verifyManifest(W.utf8(got.bytes),{owner:config.principal,directory:h.directory,now:h.clock.now(),trusted:[expect?.digest,job?.takeover.digest].filter(Boolean)});
  let segments;
  if(job){
   // Resuming: storage must still hold our takeover (or a later manifest of ours).
   if(!(equalDigest(m.digest,job.takeover.digest)||(sameWriter(m.payload.writer,signer)&&m.payload.generation>job.takeover.generation)))fault('archive_conflict','Another app took over your archive during the import.',409);
   segments=job.segments;
  }else{
   // With an anchor only that exact manifest is accepted: a later one cannot be shown to descend from it (BB6-S3).
   if(expect&&!equalDigest(m.digest,expect.digest))fault('archive_stale','The archive in your storage is not the one your previous app exported.',409);
   segments=m.payload.segments;
  }
  const blobs=new Map(),records=await readAll(storage,config.principal,segments,unwrap,blobs);
  await verifyImported(records,h.directory,h.clock.now(),h.userStorage,config.principal);
  if(!job){
   await attest(h,signer);
   const now=h.clock.now(),payload={...m.payload,generation:m.payload.generation+1,previous:m.digest,writer:{client_id:signer.client_id,cnx:signer.cnx,jkt:signer.jkt},leaseUntil:now+h.caps.leaseMs,writtenAt:now,handoff:false,plan:null,takeover:{generation:m.payload.generation,digest:m.digest,client_id:m.payload.writer.client_id,cnx:m.payload.writer.cnx},delegation:signer.delegation};
   const compact=await W.signManifest(payload,signer),bytes=te.encode(compact),manifestDigest=await W.digest(bytes);
   let version;try{version=await storage.put(W.MANIFEST_KEY,bytes,{version:got.version});}catch(error){if(error?.code==='conflict')fault('archive_conflict','Your archive changed during the import. Try again.',409);throw error;}
   job={source:{generation:m.payload.generation,digest:m.digest,checkpointAt:m.payload.writtenAt},takeover:{generation:payload.generation,digest:manifestDigest},segments,anchored:Boolean(expect),phase:0,batch:0,counts:{},startedAt:now,done:false};
   const referenced=new Set([...segments.map(s=>s.name),...[...blobs.values()].flat().map(b=>b.name)]);
   await store.transaction(async tx=>{for(const r of m.payload.retired)if(!referenced.has(r.name))await tx.put(A.gc(r.name),{name:r.name,version:null,after:Math.max(now,Math.min(r.after,now+h.caps.gcGraceMs)),attempts:0});await tx.put(A.import,job);await tx.put(A.state,{generation:payload.generation,version,digest:manifestDigest,base:payload.base,segments:segments.map(s=>({...localSegment(s,null),blobs:blobs.get(s.name)??[]})),writer:payload.writer,leaseUntil:payload.leaseUntil,lastCheckpointAt:null,fenced:false,shadowInvalid:true,imported:{generation:m.payload.generation,digest:m.digest}});});
  }
  if(job.phase>0)await store.transaction(tx=>tx.delete('archive/hold'));
  for(let phase=job.phase;phase<4;phase++){
   const rows=records.filter(r=>r.phase===phase);
   for(let batch=phase===job.phase?job.batch:0;batch*h.caps.batchRows<rows.length;batch++){
    await store.transaction(async tx=>{await guard(h,tx);const live=await tx.get(A.import);const counts={...live.counts};await applyBatch(tx,rows.slice(batch*h.caps.batchRows,(batch+1)*h.caps.batchRows),counts);await tx.put(A.import,{...live,phase,batch:batch+1,counts});});
   }
   job=await store.transaction(async tx=>{const live={...await tx.get(A.import),phase:phase+1,batch:0};await tx.put(A.import,live);if(phase===0)await tx.delete('archive/hold');return live;});
  }
  const result={generation:job.takeover.generation,source:job.source.generation,imported:job.counts,resend:(await store.list({prefix:A.resends})).size,anchored:job.anchored,next:['conversations.rejoin']};
  await store.transaction(async tx=>{await tx.put(A.import,{...await tx.get(A.import),done:true,doneAt:h.clock.now(),result});await tx.delete('archive/hold');});
  return result;
 });
}

// Restore boundary for the receive and conversation admission paths (spec §8.2, review S-9): while `importing` is true
// only control state is complete; envelopes created before `checkpointAt` are admissible only from the imported replay
// set. Exported for the shell integration (not yet wired).
export async function archiveRestore(store){const job=await store.get(A.import);if(await store.get('archive/hold'))return {importing:true,controlRestored:false,checkpointAt:job?.source.checkpointAt??null};return job?{importing:!job.done,controlRestored:job.phase>0||Boolean(job.done),checkpointAt:job.source.checkpointAt}:null;}

// Capacity reclamation. Hot: final, archived (shadow matches) send obligations past any manual catch-up become
// summaries; their bodies are deleted and the B3 queue counters released. Storage: superseded objects past the grace
// period and abandoned objects are deleted by exact version; a backend without conditional deletion keeps them,
// reported as retained.
async function reclaim(h){
 if(!h.enabled)disabled();
 const store=h.store,now=h.clock.now(),state=await store.get(A.state);let tasks=0,messages=0,bytes=0,deleted=0,retained=0,pending=0;
 if(state?.generation&&!state.shadowInvalid&&!state.fenced){
  const rows=await store.transaction(async tx=>{const meta=await tx.get(SEND.queue);if(!meta)return [];const out=[];for(const id of meta.messages){const m=await tx.get(SEND.message+id);if(!m)continue;const ts=[];for(const k of m.tasks)ts.push([k,await tx.get(k)]);out.push({id,m,ts});}return out;});
  const shadowOf=async key=>(await store.get(A.shadow(bucket(key))))?.[key]?.h;
  const done=[];
  for(const {id,m,ts} of rows){
   const ready=ts.every(([,t])=>t&&FINAL.has(t.state)&&!t.lease&&(t.state!=='expired'||t.manualUsed||now>=W.manualEnd(t)));if(!ready)continue;
   let archived=await shadowOf(SEND.message+id)===await hash(W.lineOf(SEND.message+id,m));
   for(const [k,t] of ts)if(archived&&await shadowOf(k)!==await hash(W.lineOf(k,t)))archived=false;
   if(archived)done.push(id);
  }
  if(done.length)await store.transaction(async tx=>{
   const meta=await tx.get(SEND.queue);if(!meta)return;const set=new Set(done);
   for(const id of done){
    const m=await tx.get(SEND.message+id);if(!m||m.compact)continue;let size=0;
    for(const k of m.bodyKeys??[]){const chunk=await tx.get(k);size+=chunk?.length??0;await tx.delete(k);}
    for(const k of m.tasks){const t=await tx.get(k);if(!t||!FINAL.has(t.state)||t.lease){set.delete(id);continue;}size+=(t.envelope?te.encode(P.jcs(t.envelope)).byteLength:0)+(t.credential?.length??0)+(t.secret?.length??0)+512;if(!t.compact){await tx.put(k,W.compactTask(t));tasks++;}}
    if(!set.has(id))continue;
    await tx.put(SEND.message+id,W.compactMessage(m));messages++;bytes+=size;meta.tasks=Math.max(0,meta.tasks-m.tasks.length);meta.bytes=Math.max(0,meta.bytes-size);
   }
   // Byte estimates cannot be rebuilt exactly after secrets and credentials were purged; an empty queue holds nothing.
   meta.messages=meta.messages.filter(id=>!set.has(id));if(!meta.messages.length){meta.tasks=0;meta.bytes=0;}await tx.put(SEND.queue,meta);
  });
 }
 const live=objectsOf(state?.segments??[]),gc=[...(await store.list({prefix:A.gcs})).entries()].filter(([,g])=>g.after<=now&&!g.retained);
 if(gc.length){
  const storage=W.storageClient(h.userStorage);
  for(const [k,g] of gc){
   if(live.has(g.name)){await store.transaction(tx=>tx.delete(k));continue;}
   try{
    let version=g.version;if(version===null){const got=await storage.get(g.name);if(!got){await store.transaction(tx=>tx.delete(k));deleted++;continue;}version=got.version;}
    const r=await storage.delete(g.name,version);
    if(r==='unsupported'){await store.transaction(tx=>tx.put(k,{...g,retained:true}));retained++;}else{await store.transaction(tx=>tx.delete(k));deleted++;}
   }catch{pending++;await store.transaction(tx=>tx.put(k,{...g,attempts:(g.attempts??0)+1,after:now+Math.min(86400000,60000*2**Math.min(10,g.attempts??0))}));}
  }
 }
 return {tasks,messages,bytes,deleted,retained,pending};
}

async function verifyArchive(h){
 if(!h.enabled)disabled();
 const store=h.store,config=await readConfig(store),storage=W.storageClient(h.userStorage),signer=await archiveSigner(h,config,h.clock.now()),state=await store.get(A.state);
 const got=await storage.get(W.MANIFEST_KEY);if(!got)fault('archive_missing','No archive was found in your storage.',404);
 const m=await W.verifyManifest(W.utf8(got.bytes),{owner:config.principal,directory:h.directory,now:h.clock.now(),trusted:[state?.digest].filter(Boolean)});
 const records=await readAll(storage,config.principal,m.payload.segments,unwrapper(h,signer));
 return {ok:true,generation:m.payload.generation,segments:m.payload.segments.length,records:records.length,writer:sameWriter(m.payload.writer,signer)?'self':'other',current:m.digest===state?.digest};
}

export class ArchiveCheckpoint extends MailboxAction {
 static operation='archive.checkpoint';static deps=['archive'];static changes='archive-changed';
 run({archive}){actorOwner(this.actor,['owner','system']);return checkpoint(archive,{mode:this.input?.snapshot===true?'snapshot':'auto'});}
}
export class ArchiveCompact extends MailboxAction {
 static operation='archive.compact';static deps=['archive'];static changes='archive-changed';
 run({archive}){actorOwner(this.actor,['owner','system']);return checkpoint(archive,{mode:'snapshot'});}
}
// The previous occupant's handoff: a complete snapshot; the result is the anchor the switch flow gives the new app.
export class ArchiveExport extends MailboxAction {
 static operation='archive.export';static deps=['archive'];static changes='archive-changed';
 async run({archive}){actorOwner(this.actor);const r=await checkpoint(archive,{handoff:true});return {generation:r.generation,digest:r.digest,segments:r.segments,reused:r.reused,records:r.records};}
}
export class ArchiveImport extends MailboxAction {
 static operation='archive.import';static deps=['archive'];static changes='archive-changed';
 run({archive}){actorOwner(this.actor);return importArchive(archive,{expect:this.input?.expect,unanchored:this.input?.unanchored});}
}
export class ArchiveReclaim extends MailboxAction {
 static operation='archive.reclaim';static deps=['archive'];static changes='archive-changed';
 run({archive}){actorOwner(this.actor,['owner','system']);return reclaim(archive);}
}
export class ArchiveVerify extends MailboxAction {
 static operation='archive.verify';static deps=['archive'];
 run({archive}){actorOwner(this.actor);return verifyArchive(archive);}
}
// Owner status: no object names, keys or contents. The archive is encrypted to the owner's key, which the provider
// holds today, so it is not end-to-end encrypted; the UI must say so.
export class ArchiveStatus extends MailboxQuery {
 static operation='archive.status';static deps=['archive'];static refreshOn=['archive-changed'];
 async fetch({archive:h}){
  actorOwner(this.actor);const s=await h.store.get(A.state)??{},job=await h.store.get(A.import),journal=await h.store.get(A.journal),gc=[...(await h.store.list({prefix:A.gcs})).values()],now=h.clock.now();
  return {enabled:h.enabled,generation:s.generation??0,segments:(s.segments??[]).length,bytes:(s.segments??[]).reduce((n,x)=>n+x.bytes,0),lastCheckpointAt:s.lastCheckpointAt??null,due:!s.lastCheckpointAt||now-s.lastCheckpointAt>=h.caps.checkpointMs,
   fenced:Boolean(s.fenced),leaseUntil:s.leaseUntil??null,encrypted:true,endToEnd:false,interrupted:Boolean(journal),importing:Boolean(await h.store.get('archive/hold')||job&&!job.done),imported:job?.done?{generation:job.source.generation,anchored:job.anchored}:null,
   pendingDeletion:gc.filter(g=>!g.retained).length,retainedObjects:gc.filter(g=>g.retained).length,resend:(await h.store.list({prefix:A.resends})).size};
 }
}
export const ARCHIVE_OPERATIONS=[ArchiveCheckpoint,ArchiveCompact,ArchiveExport,ArchiveImport,ArchiveReclaim,ArchiveVerify,ArchiveStatus];

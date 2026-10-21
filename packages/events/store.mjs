// The 3sln.me-hosted event bus (docs/spec/events.md §3.1, §4, §6, §8, §9) over one account's transactional metadata
// store (DO ctx.storage, Node SqliteMetadata). Every mutation is one transaction that re-reads the bus, re-checks the
// live connection and applies journal, rate, allowance and retention rules before writing, so it is correct without
// the account gate. MACs, digests and the outside-the-store grant check run before the transaction: a DO storage
// transaction awaits storage only.
//
// Rows (all under evbus/, owner-bound by the account store):
//   bus/<id>                       bus record: pinned manifest snapshot, head, dropped, count, bytes, incarnation
//   index/<sha256(manifest URL)>   the one bus of this manifest (one per account, §3.1)
//   rec/<id>/<seq:16>              one record; retained records are exactly seq dropped+1..head
//   reader/<id>/<principal>        reader floor {floor, nonce, epoch}: set when read is first gained (§6.3)
//   permit/<id>/<principal>        owner history opt-in, consumed when the floor is set
//   tx/<id>/<publisher>/<tx>       publish journal {fingerprint, seq, at, expiresAt} (§4.1)
//   rate/<id>/<publisher|*>        fixed-minute publish windows
//   meter/<day>/<name>             event allowance, empty reads and wait-seconds per UTC day (§9)
//   wait/<lease>                   admitted long-poll leases (the wait itself is held outside the account object)
import {canonical} from '../core/primitives.mjs';
import {digest} from '../core/records.mjs';
import {validateBusManifest} from '../federation/event-buses.mjs';
import {BUS_LIMITS as L,planOf,txRetentionSeconds,busLimits,EVENT_BUS_CONTRACT} from './limits.mjs';
import {checkRecord,jsonBytes} from './schema.mjs';
import {mintCursor,openCursor,receiptFor,principalKey} from './cursor.mjs';

export class BusFault extends Error{constructor(code,message=code,status=400,retryAfter){super(message);this.name='BusFault';this.code=code;this.status=status;if(retryAfter)this.retryAfter=retryAfter;}}
const fail=(code,message,status,retryAfter)=>{throw new BusFault(code,message,status,retryAfter);};
const forbidden=()=>fail('forbidden','This feed access is not allowed.',403);
const missing=()=>fail('not_found','Feed not found.',404);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const UUIDISH=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pad=seq=>String(seq).padStart(16,'0');
// Active buses plus tombstones awaiting sweeps. Creation refuses while this many rows exist, so listings never truncate.
const BUS_ROWS=200;
const K={bus:id=>`evbus/bus/${id}`,index:hash=>`evbus/index/${hash}`,rec:(id,seq)=>`evbus/rec/${id}/${pad(seq)}`,recs:id=>`evbus/rec/${id}/`,reader:(id,p)=>`evbus/reader/${id}/${p}`,permit:(id,p)=>`evbus/permit/${id}/${p}`,
 tx:(id,p,tx)=>`evbus/tx/${id}/${p}/${tx}`,rate:(id,p)=>`evbus/rate/${id}/${p}`,meter:(day,name)=>`evbus/meter/${day}/${name}`,wait:id=>`evbus/wait/${id}`};
const rows=async(tx,prefix,options={})=>[...(await tx.list({prefix,...options})).entries()];
const dayOf=now=>Math.floor(now/86400000),toNextDay=now=>Math.max(1,Math.ceil(((dayOf(now)+1)*86400000-now)/1000));
const exact=(value,allowed)=>plain(value)&&Object.keys(value).every(name=>allowed.includes(name));
const summary=bus=>({id:bus.id,manifest:bus.manifest,digest:bus.digest,title:bus.title,host:bus.host,types:[...bus.spec.types],publishers:[...bus.spec.publishers],readers:[...bus.spec.readers],history:bus.spec.history??'never',
 retention:{seconds:bus.retentionSeconds,min:bus.spec.retention.min_seconds,max:bus.spec.retention.max_seconds},records:bus.count,bytes:bus.bytes,head:bus.head,createdAt:bus.createdAt,features:structuredClone(bus.features??{})});

/** Validate an actor built by trusted adapter code (never a request body). */
export function busActor(actor){
 if(actor?.kind==='app'){
  const ok=exact(actor,['kind','owner','clientId','origin','connection'])&&typeof actor.clientId==='string'&&actor.clientId.length>0&&actor.clientId.length<=512&&typeof actor.origin==='string'&&/^https?:\/\/[^/]+$/.test(actor.origin)&&actor.origin.length<=512
   &&exact(actor.connection,['id','generation'])&&typeof actor.connection.id==='string'&&actor.connection.id.length<=64&&Number.isSafeInteger(actor.connection.generation);
  if(!ok)fail('unauthorized','Application authorization is required.',401);return {kind:'application',client:`app:${actor.clientId}`,stamp:{kind:'application',client_id:actor.clientId,origin:actor.origin}};
 }
 if(actor?.kind==='feature'){if(!exact(actor,['kind','owner','feature'])||typeof actor.feature!=='string'||!/^[a-z][a-z0-9.:/_-]{0,199}$/.test(actor.feature))fail('unauthorized','Feature authorization is required.',401);return {kind:'provider',client:`feature:${actor.feature}`,stamp:{kind:'provider',feature:actor.feature}};}
 fail('unauthorized','Application authorization is required.',401);
}

/**
 * One owner's buses. `grants.check({actor, bus, method})` -> {allowed, epoch, history?}: the live fragment-grant check
 * (run before every publish/read and after every wait); `grants.live(tx, actor)` -> boolean re-checks the connection
 * inside the commit. `notifier` {advance({owner,bus,head}), revoke({owner,bus})} reaches the separate wait object;
 * failures are swallowed (a missed doorbell only delays a waiter until its timeout).
 */
export class BusStore{
 constructor({accountStore,clock,random,keys,owner,issuer,plan='free',grants,notifier,crypto=globalThis.crypto,waits=false,limits=L,readRate=new Map()}){
  Object.assign(this,{store:accountStore,clock,random,keys,owner,issuer,plan:planOf(plan),grants,notifier,crypto,waits:waits===true,L:limits});
  // Per-grant read rate (2/s) lives with the long-lived provider, not this per-operation handle; it is not durable.
  this.readRate=readRate;
 }
 now(){return this.clock.now();}
 async busRow(tx,id){if(typeof id!=='string'||!UUIDISH.test(id))missing();const bus=await tx.get(K.bus(id));if(!bus||bus.state!=='active'||bus.owner!==this.owner)missing();return bus;}
 retentionCap(){return this.L.retentionCapSeconds[this.plan];}

 // Owner operations. Purge, delete, retention and history are host owner-interface actions; no app grant reaches them.
 async list(){const listed=await this.store.list({prefix:'evbus/bus/',limit:BUS_ROWS});return [...listed.values()].filter(bus=>bus?.state==='active'&&bus.owner===this.owner).map(summary).sort((a,b)=>a.createdAt-b.createdAt||(a.id<b.id?-1:1));}
 async get(id){return summary(await this.busRow(this.store,id));}
 /** Create the built-in occupant for a pinned manifest snapshot, once per (account, manifest URL). The snapshot is
  * re-validated with EV-1 here and its digest recomputed; nothing the caller says about it is trusted. */
 async create({manifest,url}={}){
  if(!plain(manifest)||typeof url!=='string'||url.length>2048)fail('invalid_request','A pinned feed manifest is required.');
  let checked;try{checked=validateBusManifest(structuredClone(manifest),url);}catch(error){if(!error?.code)throw error;checked={status:'invalid'};}if(checked.status!=='valid')fail('invalid_bus',`The feed manifest is ${checked.status}.`,400);
  const spec=checked.bus,cap=this.retentionCap(),seconds=Math.min(spec.retention.max_seconds,cap);
  if(seconds<spec.retention.min_seconds)fail('retention_unavailable','This plan cannot keep events as long as the feed requires.',409);
  const [hash,manifestDigest]=await Promise.all([digest(this.crypto,`bindle-event-bus-index-v1\0${url}`),digest(this.crypto,canonical(manifest))]);
  const id=this.random.uuid(),incarnation=this.random.uuid(),now=this.now();
  return this.store.transaction(async tx=>{
   const bound=await tx.get('owner');if(bound!==undefined&&bound!==this.owner)forbidden();
   const prior=await tx.get(K.index(hash));if(prior){const bus=await tx.get(K.bus(prior));if(bus?.state==='active')return {created:false,bus:summary(bus)};}
   const listed=await rows(tx,'evbus/bus/',{limit:BUS_ROWS});if(listed.length>=BUS_ROWS-1)fail('temporarily_unavailable','Deleted feeds are still being cleaned up. Try again later.',503,60);
   const active=listed.filter(([,bus])=>bus?.state==='active').length;
   if(active>=this.L.buses[this.plan])fail('bus_limit','This account has reached its feed limit.',409);
   const bus={v:1,id,owner:this.owner,state:'active',manifest:url,digest:'sha256-'+manifestDigest,title:typeof manifest.title==='string'?manifest.title.slice(0,200):url,host:new URL(url).host,spec,retentionSeconds:seconds,
    head:0,dropped:0,count:0,bytes:0,lastAt:0,incarnation,createdAt:now,features:{}};
   await tx.put(K.bus(id),bus);await tx.put(K.index(hash),id);return {created:true,bus:summary(bus)};
  });
 }
 async setRetention({bus:id,seconds}={}){
  return this.store.transaction(async tx=>{const bus=await this.busRow(tx,id);const max=Math.min(bus.spec.retention.max_seconds,this.retentionCap());
   if(!Number.isSafeInteger(seconds)||seconds<bus.spec.retention.min_seconds||seconds>max)fail('invalid_request',`Retention must be between ${bus.spec.retention.min_seconds} and ${max} seconds.`);
   bus.retentionSeconds=seconds;await tx.put(K.bus(id),bus);return summary(bus);});
 }
 /** Logical purge in one commit: head is kept, every retained record becomes a gap; rows are deleted by sweeps. */
 async purge({bus:id}={}){return this.store.transaction(async tx=>{const bus=await this.busRow(tx,id);bus.dropped=bus.head;bus.count=0;bus.bytes=0;await tx.put(K.bus(id),bus);return summary(bus);});}
 /** Delete the bus: grants on it become unusable at once (the record is a tombstone until sweeps remove the rows). */
 async remove({bus:id}={}){
  const hash=await digest(this.crypto,`bindle-event-bus-index-v1\0${(await this.busRow(this.store,id)).manifest}`);
  const result=await this.store.transaction(async tx=>{const bus=await this.busRow(tx,id);bus.state='deleted';bus.deletedAt=this.now();await tx.put(K.bus(id),bus);if(await tx.get(K.index(hash))===id)await tx.delete(K.index(hash));return {deleted:true};});
  await this.signal('revoke',{bus:id});return result;
 }
 /** Owner history opt-in for one reader (§6.3): only for `history: "owner-choice"` manifests and only before that
  * reader's floor exists; never lowers an existing floor. */
 async allowHistory({bus:id,clientId}={}){
  if(typeof clientId!=='string'||!clientId||clientId.length>512)fail('invalid_request','Name the app.');
  const principal=await principalKey(this.keys,'client',`app:${clientId}`);
  return this.store.transaction(async tx=>{const bus=await this.busRow(tx,id);if(bus.spec.history!=='owner-choice')fail('history_unavailable','This feed does not allow earlier events to be shared.',409);
   if(await tx.get(K.reader(id,principal)))fail('reader_floor_set','This app already reads this feed; earlier events cannot be added now.',409);
   await tx.put(K.permit(id,principal),{at:this.now()});return {history:true};});
 }
 /** Owner enablement of a provider feature as a reader and/or publisher (§5, extensions §5.3). */
 async setFeature({bus:id,feature,read=false,publish=false}={}){
  if(typeof feature!=='string'||!/^[a-z][a-z0-9.:/_-]{0,199}$/.test(feature)||typeof read!=='boolean'||typeof publish!=='boolean')fail('invalid_request','Unsupported feature setting.');
  return this.store.transaction(async tx=>{const bus=await this.busRow(tx,id);
   if(read&&!bus.spec.readers.includes('provider')||publish&&!bus.spec.publishers.includes('provider'))fail('invalid_request','The feed manifest does not allow provider features in this role.');
   bus.features={...bus.features};if(!read&&!publish)delete bus.features[feature];else{if(!bus.features[feature]&&Object.keys(bus.features).length>=16)fail('invalid_request','Too many features.');bus.features[feature]={read,publish};}
   await tx.put(K.bus(id),bus);if(!read)await tx.delete(K.reader(id,await this.readerKeyFor(`feature:${feature}`)));return summary(bus);});
 }
 async readerKeyFor(client){return principalKey(this.keys,'client',client);}

 // System operations (trusted adapters: consent, revocation hooks, maintenance).
 /** Set the reader floor when a grant first gains `read` (§6.3). `epoch` names the continuous read authority (for
  * example connection id and generation); the same epoch never moves an existing floor. */
 async readerApproved({bus:id,clientId,epoch,history=false}={}){
  if(typeof clientId!=='string'||!clientId||typeof epoch!=='string'||!epoch||epoch.length>256)fail('invalid_request','Reader approval needs a client and epoch.');
  const principal=await this.readerKeyFor(`app:${clientId}`),nonce=this.random.uuid();
  return this.store.transaction(async tx=>{const bus=await this.busRow(tx,id);const reader=await tx.get(K.reader(id,principal));if(reader?.epoch===epoch)return {floor:'kept'};
   await this.newFloor(tx,bus,principal,epoch,nonce,history===true);return {floor:'set'};});
 }
 /** Drop reader state for a client (all buses, or one) and wake held waits so they re-check and fail closed. */
 async readerRevoked({bus,clientId}={}){
  if(typeof clientId!=='string'||!clientId)fail('invalid_request','Name the app.');
  const principal=await this.readerKeyFor(`app:${clientId}`),targets=[];
  await this.store.transaction(async tx=>{for(const [,row]of await rows(tx,'evbus/bus/',{limit:BUS_ROWS})){if(row?.owner!==this.owner||bus!==undefined&&row.id!==bus)continue;targets.push(row.id);await tx.delete(K.reader(row.id,principal));await tx.delete(K.permit(row.id,principal));}});
  for(const target of targets)await this.signal('revoke',{bus:target});return {revoked:targets.length};
 }
 async newFloor(tx,bus,principal,epoch,nonce,history){
  const permit=await tx.get(K.permit(bus.id,principal)),opened=bus.spec.history==='owner-choice'&&(history||!!permit);
  const reader={floor:opened?bus.dropped:bus.head,nonce,epoch,since:this.now()};await tx.put(K.reader(bus.id,principal),reader);if(permit)await tx.delete(K.permit(bus.id,principal));return reader;
 }
 async signal(kind,{bus,head}){try{await this.notifier?.[kind]?.({owner:this.owner,bus,...head!==undefined?{head}:{}});}catch{}}

 // Shared admission helpers.
 async authorize(actor,id,method){
  const who=busActor(actor),bus=await this.busRow(this.store,id);
  if(who.kind==='provider'){const feature=bus.features?.[who.stamp.feature];if(!(method==='read'?feature?.read:feature?.publish))forbidden();return {who,bus,grant:{allowed:true,epoch:`feature:${bus.incarnation}`}};}
  if(!(method==='read'?bus.spec.readers:bus.spec.publishers).includes('application'))forbidden();
  let grant;try{grant=await this.grants?.check({actor,bus:{id:bus.id,manifest:bus.manifest,digest:bus.digest,incarnation:bus.incarnation},method});}catch(error){if(['forbidden','unauthorized','invalid_token'].includes(error?.code))forbidden();throw error;}
  if(grant?.allowed!==true||typeof grant.epoch!=='string'||!grant.epoch||grant.epoch.length>256)forbidden();
  return {who,bus,grant};
 }
 async live(tx,actor){if(actor.kind==='feature')return;if(typeof this.grants?.live==='function'&&await this.grants.live(tx,actor)!==true)forbidden();}

 // App operations.
 /** publish {type, data} under a stable `tx` (§4.1). The result carries an opaque receipt, never `seq`. */
 async publish(actor,args,{tx:txId}={}){
  if(!exact(args,['type','data'])||!Object.hasOwn(args,'type')||!Object.hasOwn(args,'data'))fail('invalid_args','Publish takes {type, data}.');
  if(typeof txId!=='string'||!UUIDISH.test(txId.toLowerCase()))fail('invalid_args','A transaction UUID is required.');
  const {who,bus}=await this.authorize(actor,this.busId,'publish'),checked=checkRecord(bus.spec,args,this.L.maxRecordBytes);
  if(!checked.ok)fail('invalid_args',`The event does not match the feed manifest (${checked.reason}).`);
  const publisher=await principalKey(this.keys,'publisher',canonical(who.stamp)),data=structuredClone(args.data);
  const fingerprint=await digest(this.crypto,canonical(['bindle-event-publish-v1',bus.id,bus.incarnation,args.type,data,who.stamp]));
  const now=this.now(),id=bus.id,key=K.tx(id,publisher,txId.toLowerCase());
  const outcome=await this.store.transaction(async tx=>{
   const current=await this.busRow(tx,id);if(current.incarnation!==bus.incarnation)forbidden();await this.live(tx,actor);
   const prior=await tx.get(key);
   if(prior&&prior.expiresAt>now){if(prior.fingerprint!==fingerprint)fail('tx_conflict','The transaction was already used for another event.',409);return {seq:prior.seq,at:prior.at,replay:true};}
   const minute=Math.floor(now/60000),retry=Math.max(1,Math.ceil(((minute+1)*60000-now)/1000));
   const own=await tx.get(K.rate(id,publisher)),all=await tx.get(K.rate(id,'*')),ownCount=own?.minute===minute?own.count:0,allCount=all?.minute===minute?all.count:0;
   // Both refusals carry the caller's own window. A refusal below the caller's own limit still shows that the shared
   // limit was reached (accepted residual EV2-S5; spec §6.3 tolerates the refusal, never its timing).
   if(ownCount>=this.L.publishPerMinute||allCount>=this.L.busPublishPerMinute)fail('rate_limited','This app is publishing too fast.',429,retry);
   const day=dayOf(now),allowance=this.L.allowance[this.plan],share=Math.floor(allowance*this.L.publisherShare);
   const total=await tx.get(K.meter(day,'total'))??0,mine=await tx.get(K.meter(day,`pub/${publisher}`))??0;
   if(total>=allowance||mine>=share)fail('rate_limited','The feed event allowance is used up for today.',429,toNextDay(now));
   await this.ageOut(tx,current,now,64);
   const seq=current.head+1,at=Math.max(current.lastAt,Math.floor(now/1000));
   await tx.put(K.rec(id,seq),{seq,type:args.type,published_at:at,publisher:who.stamp,data,bytes:checked.bytes});
   Object.assign(current,{head:seq,count:current.count+1,bytes:current.bytes+checked.bytes,lastAt:at});
   // Caps age the oldest records out first; a publish never fails because of retention (§4.4).
   while((current.count>this.L.maxRetainedRecords||current.bytes>this.L.maxRetainedBytes)&&current.dropped<current.head-1){const old=await tx.get(K.rec(id,current.dropped+1));await tx.delete(K.rec(id,current.dropped+1));current.dropped++;current.count--;current.bytes-=old?.bytes??0;}
   await tx.put(K.bus(id),current);
   await tx.put(K.rate(id,publisher),{minute,count:ownCount+1});await tx.put(K.rate(id,'*'),{minute,count:allCount+1});
   await tx.put(K.meter(day,'total'),total+1);await tx.put(K.meter(day,`pub/${publisher}`),mine+1);
   await tx.put(key,{fingerprint,seq,at,expiresAt:now+txRetentionSeconds(current)*1000});
   return {seq,at,replay:false};
  });
  if(!outcome.replay)await this.signal('advance',{bus:id,head:outcome.seq});
  return {receipt:await receiptFor(this.keys,{owner:this.owner,bus:id,incarnation:bus.incarnation,seq:outcome.seq}),published_at:outcome.at};
 }
 /** Delete up to `limit` records older than the effective retention. Returns true when more remain. */
 async ageOut(tx,bus,now,limit){
  const cutoff=Math.floor(now/1000)-bus.retentionSeconds;let n=0;
  for(const [path,record]of await rows(tx,K.recs(bus.id),{startAfter:K.rec(bus.id,bus.dropped),limit})){
   if(record.seq<=bus.dropped||record.published_at>cutoff)return false;
   await tx.delete(path);bus.dropped=record.seq;bus.count--;bus.bytes-=record.bytes??0;n++;
  }
  return n>=limit;
 }
 readRateOk(id,principal){
  const now=this.now(),key=`${id}/${principal}`,bucket=this.readRate.get(key)??{tokens:this.L.reads.perSecond,at:now};
  bucket.tokens=Math.min(this.L.reads.perSecond,bucket.tokens+(now-bucket.at)*this.L.reads.perSecond/1000);bucket.at=now;
  if(this.readRate.size>4096&&!this.readRate.has(key))this.readRate.clear();
  if(bucket.tokens<1){this.readRate.set(key,bucket);return false;}bucket.tokens-=1;this.readRate.set(key,bucket);return true;
 }
 /**
  * read {cursor} | {start} | {} with optional limit and wait (§4.2). With `hold` (the calling adapter holds waits in the
  * separate wait object) an empty answer with wait > 0 is admitted as a lease and returned as `{wait}` for the adapter to hold outside
  * this object; `resume` (the lease) continues it after the wait and re-checks the grant first.
  */
 async read(actor,args={},{resume,hold=false}={}){
  if(!exact(args,['cursor','start','limit','wait'])||Object.hasOwn(args,'cursor')&&Object.hasOwn(args,'start'))fail('invalid_args','Read takes {cursor} or {start}, with optional limit and wait.');
  if(args.start!==undefined&&!['oldest','latest'].includes(args.start))fail('invalid_args','start is "oldest" or "latest".');
  const limit=args.limit===undefined?this.L.reads.defaultLimit:args.limit,wait=args.wait===undefined?0:args.wait;
  if(!Number.isSafeInteger(limit)||limit<1||limit>this.L.reads.maxLimit||!Number.isSafeInteger(wait)||wait<0||wait>this.L.waits.maxWaitSeconds)fail('invalid_args','limit is 1-100 and wait is 0-25 seconds.');
  const who=busActor(actor),id=this.busId,principal=await this.readerKeyFor(who.client);
  if(resume!==undefined)await this.releaseWait({lease:resume,bus:id,reader:principal});
  const {bus,grant}=await this.authorize(actor,id,'read');
  if(resume===undefined&&!this.readRateOk(id,principal))fail('rate_limited','Reading too fast.',429,1);
  const scope={owner:this.owner,bus:id,client:who.client},opened=args.cursor===undefined?null:await openCursor(this.keys,scope,args.cursor);
  const nonce=this.random.uuid(),lease=this.random.uuid(),now=this.now(),holding=hold===true&&resume===undefined&&wait>0;
  const outcome=await this.store.transaction(async tx=>{
   const current=await this.busRow(tx,id);if(current.incarnation!==bus.incarnation)forbidden();await this.live(tx,actor);
   let reader=await tx.get(K.reader(id,principal));
   if(!reader||reader.epoch!==grant.epoch){if(opened)fail('invalid_args','The cursor is not valid for this reader.');reader=await this.newFloor(tx,current,principal,grant.epoch,nonce,grant.history===true);}
   let position;
   if(opened){if(opened.incarnation!==current.incarnation||opened.floor!==reader.floor||opened.nonce!==reader.nonce||opened.position>current.head)fail('invalid_args','The cursor is not valid for this reader.');position=opened.position;}
   else position=args.start==='oldest'?reader.floor:Math.max(current.head,reader.floor);
   const dropped=current.dropped,stale=await this.ageOut(tx,current,now,500);if(current.dropped!==dropped)await tx.put(K.bus(id),current);
   // Below the floor resumes at the floor without a gap; below `dropped` reports exactly the lost range (§4.2).
   position=Math.max(position,reader.floor);let gap=null;
   if(position<current.dropped){gap={from:position+1,to:current.dropped};position=current.dropped;}
   const records=[],cutoff=Math.floor(now/1000)-current.retentionSeconds;let size=0;
   for(const [,record]of await rows(tx,K.recs(id),{startAfter:K.rec(id,position),limit})){
    if(record.seq<=position)continue;
    if(stale&&record.published_at<=cutoff){gap={from:gap?.from??position+1,to:record.seq};position=record.seq;continue;}
    const out={seq:record.seq,type:record.type,published_at:record.published_at,publisher:structuredClone(record.publisher),attested_by:this.issuer,data:structuredClone(record.data)};
    const bytes=jsonBytes(out)+1;if(records.length&&size+bytes>this.L.reads.maxResultBytes)break;size+=bytes;records.push(out);position=record.seq;
   }
   const visibleFrom=Math.max(current.dropped,reader.floor);
   const view={head:current.head>reader.floor?current.head:null,oldest:current.head>visibleFrom?visibleFrom+1:null,gap};
   if(!records.length&&holding){await this.admitWait(tx,{lease,bus:id,reader:principal,wait,now,mark:current.head});return {records,view,reader,position,current,wait:{lease,until:now+wait*1000,mark:current.head}};}
   if(!records.length)await this.chargeEmpty(tx,principal,now);
   return {records,view,reader,position,current};
  });
  const cursor=await mintCursor(this.keys,scope,{incarnation:outcome.current.incarnation,floor:outcome.reader.floor,nonce:outcome.reader.nonce,position:outcome.position});
  const result={records:outcome.records,cursor,head:outcome.view.head,oldest:outcome.view.oldest,gap:outcome.view.gap};
  return outcome.wait?{...result,wait:{lease:outcome.wait.lease,bus:id,until:outcome.wait.until,mark:outcome.wait.mark}}:result;
 }
 async chargeEmpty(tx,principal,now){
  const day=dayOf(now),key=K.meter(day,`empty/${principal}`),count=(await tx.get(key)??0)+1;
  // EV2-S2: charged empty reads draw a readers' share (25 % combined, 10 % per reader) beside the publish allowance,
  // so no reader can exhaust what publishers need, and one reader cannot starve the others.
  if(count>this.L.reads.freeEmptyPerDay){const allowance=this.L.allowance[this.plan],all=await tx.get(K.meter(day,'reads'))??0,charged=count-this.L.reads.freeEmptyPerDay;
   if(all>=Math.floor(allowance*this.L.readerShare)||charged>Math.floor(allowance*this.L.readerOwnShare))fail('rate_limited','Too many empty reads today.',429,toNextDay(now));await tx.put(K.meter(day,'reads'),all+1);}
  await tx.put(key,count);
 }
 async admitWait(tx,{lease,bus,reader,wait,now,mark}){
  const live=[];
  for(const [path,row]of await rows(tx,'evbus/wait/',{limit:64})){if(row.until+this.L.waits.graceSeconds*1000<=now)await tx.delete(path);else live.push(row);}
  if(live.some(row=>row.bus===bus&&row.reader===reader)||live.filter(row=>row.reader===reader).length>=this.L.waits.perClient||live.length>=this.L.waits.perAccount)
   fail('rate_limited','Too many waiting reads.',429,this.L.waits.overCapRetry);
  const day=dayOf(now),used=await tx.get(K.meter(day,'wait'))??0,mine=await tx.get(K.meter(day,`wait/${reader}`))??0;
  // EV2-S3: one app may spend at most its share of the account's daily wait-seconds; the refusal is the same either way.
  if(used+wait>this.L.waits.dailySeconds||mine+wait>Math.floor(this.L.waits.dailySeconds*this.L.waits.clientShare))fail('rate_limited','The waiting-read budget is used up for today.',429,Math.max(this.L.waits.budgetRetry,toNextDay(now)));
  await tx.put(K.meter(day,'wait'),used+wait);await tx.put(K.meter(day,`wait/${reader}`),mine+wait);await tx.put(K.wait(lease),{bus,reader,until:now+wait*1000,charged:wait,day,mark,at:now});
 }
 /** Release a lease (idempotent) and refund the unused wait-seconds of the same day. */
 async releaseWait({lease,bus,reader}){
  if(typeof lease!=='string'||!UUIDISH.test(lease))fail('invalid_args','Unknown waiting read.');
  const now=this.now();
  await this.store.transaction(async tx=>{const row=await tx.get(K.wait(lease));if(!row)return;if(row.bus!==bus||row.reader!==reader)fail('invalid_args','Unknown waiting read.');await tx.delete(K.wait(lease));
   const unused=Math.max(0,Math.min(row.charged,Math.floor((row.until-now)/1000)));if(unused&&row.day===dayOf(now)){for(const name of ['wait',`wait/${row.reader}`]){const used=await tx.get(K.meter(row.day,name))??0;await tx.put(K.meter(row.day,name),Math.max(0,used-unused));}}});
 }

 /** Bounded maintenance: retention, purge/deletion leftovers, expired journals, windows, meters and leases. */
 async sweep({budget=this.L.sweepBatch}={}){
  const now=this.now();let left=budget;
  for(const [,listed]of await rows(this.store,'evbus/bus/',{limit:BUS_ROWS})){
   if(left<=0)break;if(listed?.owner!==this.owner)continue;
   left=await this.store.transaction(async tx=>{
    const bus=await tx.get(K.bus(listed.id));if(!bus)return left;let n=left;
    if(bus.state==='deleted'){
     for(const prefix of [K.recs(bus.id),`evbus/reader/${bus.id}/`,`evbus/permit/${bus.id}/`,`evbus/tx/${bus.id}/`,`evbus/rate/${bus.id}/`]){for(const [path]of await rows(tx,prefix,{limit:n}))if(n-->0)await tx.delete(path);if(n<=0)return 0;}
     await tx.delete(K.bus(bus.id));return n;
    }
    for(const [path,record]of await rows(tx,K.recs(bus.id),{limit:n})){if(record.seq>bus.dropped)break;await tx.delete(path);n--;}
    const before=bus.dropped;await this.ageOut(tx,bus,now,Math.max(0,n));n-=bus.dropped-before;if(bus.dropped!==before)await tx.put(K.bus(bus.id),bus);
    for(const [path,row]of await rows(tx,`evbus/tx/${bus.id}/`,{limit:Math.max(0,n)}))if(row.expiresAt<=now){await tx.delete(path);n--;}
    for(const [path,row]of await rows(tx,`evbus/rate/${bus.id}/`,{limit:64}))if(row.minute<Math.floor(now/60000))await tx.delete(path);
    return n;
   });
  }
  await this.store.transaction(async tx=>{
   const today=dayOf(now);for(const [path]of await rows(tx,'evbus/meter/',{limit:Math.max(1,left)})){const day=Number(path.split('/')[2]);if(day<today-1){await tx.delete(path);left--;}}
   for(const [path,row]of await rows(tx,'evbus/wait/',{limit:64}))if(row.until+this.L.waits.graceSeconds*1000<=now)await tx.delete(path);
  });
  return {more:left<=0};
 }
 /** Resource descriptors for the federation resource provider (integration hunk; §4.4 limits). */
 async descriptors(){return Promise.all((await this.list()).map(async bus=>({id:`${this.issuer}/entities/${this.owner}/buses/${bus.id}`,label:bus.title,provider:'bindle',contracts:{[EVENT_BUS_CONTRACT]:['publish','read']},generation:bus.id,manifest:bus.manifest,digest:bus.digest,limits:busLimits(await this.busRow(this.store,bus.id),{waits:this.waits})})));}
 async limits(id){const bus=await this.busRow(this.store,id);return busLimits(bus,{waits:this.waits});}
 /** Bind the handle's app operations to one bus (the resource the federation grant named). */
 at(id){const scoped=Object.create(this);scoped.busId=id;return scoped;}
}

import {brokeringKeys,brokeringEnabled} from '../../packages/federation/signing.mjs';
import {activePopulationPort} from '../../packages/runtime/active-population.mjs';
import {configuredFormOrigins} from '../../packages/apps/form-fetch-policy.mjs';
import {createNodeFormFetch} from '../../packages/apps/node-form-fetch.mjs';
import {PlanCatalogRegistry,cachedCatalogPort} from '../../packages/billing/registry.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, unlink, stat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, extname } from 'node:path';
import {nodeSqlPort} from '../../packages/search/index.mjs';
import { IdentityRepository, FixedWindowGuard, AccountController } from '../../packages/runtime/accounts.mjs';
import {McpShardController,mcpAuthorities} from '../../packages/mcp/runtime.mjs';
import {FederationController,federationMetadata} from '../../packages/federation/runtime.mjs';
import {federationAuthority,federationControllerOptions,federationEntries,federationEntriesCleanup,FEDERATION_LAYOUT,federationEpoch,federationClientDirectory,clientMetadataEnabled} from '../../packages/runtime/federation.mjs';
import {createNodeClientMetadataFetch} from '../../packages/federation/node-client-metadata-fetch.mjs';
import {adminClientBlocked} from '../../packages/identity/admin.mjs';
import {metadataClientHost,clientSite} from '../../packages/federation/client-metadata.mjs';
import {digest} from '../../packages/messaging/store.mjs';
import {ENTRY_SHARDS,entryShard,remoteShard} from '../../packages/federation/authorization-entries.mjs';
import {AdminStorage} from '../../packages/identity/admin-store.mjs';
import {MemoryLinkedLimits} from '../../packages/identity/linked-approval.mjs';
import {lifecycleIdentityPort,lifecycleAdminHoldPort} from '../../packages/identity/lifecycle-tombstone.mjs';
import {lifecycleMode} from '../../packages/runtime/lifecycle-runner.mjs';
import {LifecycleSweep} from '../../packages/runtime/lifecycle-scheduler.mjs';
import {createPushTransport} from '../../packages/messaging/web-push.mjs';

export class SerialGate {
 constructor(){this.tail=Promise.resolve();}
 async run(operation){const previous=this.tail;let release;this.tail=new Promise(r=>release=r);await previous;try{return await operation();}finally{release();}}
}
export class SqliteMetadata {
 constructor(file){this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');this.gate=new SerialGate();this.timer=null;this.closed=false;this.sql=nodeSqlPort(this.db);}
 raw(){const self=this;return {
  get:async key=>{const row=self.db.prepare('SELECT value FROM records WHERE key=?').get(key);return row?JSON.parse(row.value):undefined;},
  put:async(key,value)=>{if(typeof key==='object'){for(const [k,v]of Object.entries(key))await self.raw().put(k,v);return;}self.db.prepare('INSERT INTO records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));},
  delete:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])self.db.prepare('DELETE FROM records WHERE key=?').run(key);},
  list:async({prefix='',startAfter='',limit=100000}={})=>new Map(self.db.prepare('SELECT key,value FROM records WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?').all(prefix,prefix+'\uffff',startAfter,limit).map(row=>[row.key,JSON.parse(row.value)])),
  getAlarm:async()=>self.raw().get('@alarm'),
  setAlarm:async time=>{await self.raw().put('@alarm',time);self.arm(time);}
 };}
 get(key){return this.gate.run(()=>this.raw().get(key));}
 put(key,value){return this.gate.run(()=>this.raw().put(key,value));}
 delete(key){return this.gate.run(()=>this.raw().delete(key));}
 list(options){return this.gate.run(()=>this.raw().list(options));}
 deleteAll(){return this.gate.run(()=>this.db.exec('DELETE FROM records'));}
 /** Lifecycle purge: clears every table in this account file (FTS through its virtual table, never shadow tables) and compacts it. */
 purgeAll({keep=[]}={}){return this.gate.run(()=>{const tables=this.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all(),virtual=tables.filter(t=>/^CREATE VIRTUAL TABLE/i.test(t.sql||'')).map(t=>t.name);this.db.exec('BEGIN IMMEDIATE');try{for(const {name}of tables)if(name==='records'){const statement=this.db.prepare(`DELETE FROM records WHERE key NOT IN (${keep.map(()=>'?').join(',')||"''"})`);statement.run(...keep);}else if(!virtual.some(v=>name.startsWith(v+'_')))this.db.exec(`DELETE FROM "${name.replaceAll('"','""')}"`);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}this.db.exec('VACUUM');});}
 async transaction(operation){return this.gate.run(async()=>{this.db.exec('BEGIN IMMEDIATE');try{const value=await operation(this.raw());this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}});}
 async setAlarm(time){await this.put('@alarm',time);this.arm(time);}
 getAlarm(){return this.get('@alarm');}
 arm(time){clearTimeout(this.timer);if(this.closed||!this.onAlarm)return;this.timer=setTimeout(async()=>{if(this.closed)return;if(Date.now()<time){this.arm(time);return;}try{const claimed=await this.transaction(async tx=>{if(this.closed||await tx.get('@alarm')!==time)return false;await tx.delete('@alarm');return true;});if(!claimed||this.closed)return;await this.onAlarm();}catch(error){if(this.closed)return;try{const next=await this.getAlarm();if(this.closed)return;if(!next)await this.setAlarm(Date.now()+60000);else this.arm(next);}catch(retryError){if(!this.closed)throw retryError;}}},Math.min(2147483647,Math.max(1,time-Date.now())));this.timer.unref();}
 close(){if(this.closed)return;this.closed=true;clearTimeout(this.timer);this.timer=null;this.db.close();}
}
export class FileBucket {
 constructor(directory){this.directory=directory;}
 path(key){return join(this.directory,createHash('sha256').update(key).digest('hex'));}
 async put(key,content){await mkdir(this.directory,{recursive:true,mode:0o700});const destination=this.path(key),temporary=destination+'.'+randomUUID();const bytes=typeof content==='string'?content:new Uint8Array(content);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temporary,destination);}catch(error){try{await unlink(temporary);}catch{}throw error;}const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}return {key};}
 async get(key){const path=this.path(key);try{const size=(await stat(path)).size;return {size,arrayBuffer:async()=>{const b=await readFile(path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);},text:async()=>(await readFile(path)).toString('utf8'),json:async()=>JSON.parse((await readFile(path)).toString('utf8'))};}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 async delete(keys){let deleted=false;for(const key of Array.isArray(keys)?keys:[keys])try{await unlink(this.path(key));deleted=true;}catch(error){if(error.code!=='ENOENT')throw error;}if(deleted){const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}}}
}
export async function nodeResources({directory,config,formTransport,mailer}){
 if(formTransport===undefined)try{const origins=configuredFormOrigins(config);if(origins.length)formTransport=createNodeFormFetch({allowedOrigins:origins});}catch(error){if(error.code!=='form_transport_unavailable')throw error;/* Invalid optional egress configuration disables only postbacks. */}
 if(formTransport!==undefined&&typeof formTransport?.send!=='function')throw new TypeError('Invalid form transport port.');
 await mkdir(directory,{recursive:true,mode:0o700});await mkdir(join(directory,'accounts'),{recursive:true,mode:0o700});await mkdir(join(directory,'abuse'),{recursive:true,mode:0o700});
 const catalogDb=new SqliteMetadata(join(directory,'plan-catalog.sqlite')),catalogRegistry=new PlanCatalogRegistry({metadata:catalogDb,config}),catalog=cachedCatalogPort(catalogRegistry);
 const identities=new SqliteMetadata(join(directory,'identities.sqlite'));const repository=new IdentityRepository({metadata:identities,config});identities.onAlarm=()=>repository.alarm();{const alarm=await identities.getAlarm();if(alarm)identities.arm(alarm);}
 const deviceDb=new SqliteMetadata(join(directory,'devices.sqlite'));const deviceRepo=new IdentityRepository({metadata:deviceDb});deviceDb.onAlarm=()=>deviceRepo.alarm();{const alarm=await deviceDb.getAlarm();if(alarm)deviceDb.arm(alarm);}
 const deviceRequests={create:r=>deviceRepo.createDevice(r),get:id=>deviceRepo.getDevice(id),findByUserCode:code=>deviceRepo.findDeviceByCode(code),compareAndSwap:(id,revision,r)=>deviceRepo.compareAndSwapDevice(id,revision,r)};
 // Linked approval: `deviceRequests` is also the `linkedApprovals` repository; budgets use the durable abuse windows, poll intervals a non-durable limiter.
 const linkedPollLimits=new MemoryLinkedLimits();let linkedLimits;
 const blobs=new FileBucket(join(directory,'blobs')),archives=new FileBucket(join(directory,'archives'));const accountMap=new Map(),guardMap=new Map();
 // Lifecycle ports exist only when LIFECYCLE_ENABLED. FileBucket has no storage classes, so cold tiering reports unsupported.
 let adminStore;const lifecycleConfig=lifecycleMode(config)==='off'?{}:{LIFECYCLE_IDENTITY:lifecycleIdentityPort(repository),LIFECYCLE_ADMIN_HOLD:owner=>lifecycleAdminHoldPort({store:adminStore,repository})(owner),LIFECYCLE_MAIL:mailer??null,LIFECYCLE_PUSH:createPushTransport(config),LIFECYCLE_COLD_STORAGE_SUPPORTED:false};
 let population;const guardFor=async name=>{const file=createHash('sha256').update(name).digest('hex');if(!guardMap.has(file)){const metadata=new SqliteMetadata(join(directory,'abuse',file+'.sqlite'));const guard=new FixedWindowGuard({metadata,config:{...config,...name==='active-user-v1/census'?{ACTIVE_POPULATION_CENSUS:()=>population.censusStep()}:{} }});metadata.onAlarm=()=>guard.alarm();guardMap.set(file,{metadata,guard});const alarm=await metadata.getAlarm();if(alarm)metadata.arm(alarm);}return guardMap.get(file).guard;};const abuse={waitlist:async(method,input)=>(await guardFor('signup:waitlist:v1')).waitlistAction(method,input),consume:async(name,limits)=>(await guardFor(name)).consume(limits),consumeSignup:async(name,limits)=>(await guardFor(name)).consumeSignup(limits),signupStatus:async(name,limits)=>(await guardFor(name)).signupStatus(limits)};
 // Restore the one bounded waitlist expiry alarm even before its next visitor.
 await guardFor('signup:waitlist:v1');
 const accounts={get:id=>{
   if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid account identifier');
   if(!accountMap.has(id)){const metadata=new SqliteMetadata(join(directory,'accounts',id+'.sqlite'));const controller=new AccountController({metadata,gate:new SerialGate(),blobs,archives,config:{...config,...lifecycleConfig,FORM_POSTBACK_TRANSPORT:formTransport,DEVELOPER_CONTACT_POPULATION:population,BILLING_CATALOG:catalog,FEDERATION_IDENTITY_CHECK:async(owner,epoch)=>{const account=await repository.get(owner);return account?.status==='active'&&await federationEpoch(account)===epoch;},WORK_AUTHORITY:abuse,CONVERSATION_ACCOUNT:owner=>accounts.get(owner),IDENTITY_ACCOUNT:async owner=>{const account=await repository.get(owner);return account?{status:account.status,handle:account.handle}:null;}},sql:metadata.sql});metadata.onAlarm=()=>controller.alarm();metadata.getAlarm().then(time=>{if(time)metadata.arm(time);});accountMap.set(id,{metadata,controller});}return accountMap.get(id).controller;
 }};

 population=activePopulationPort({repository,accounts,threshold:Number(config.DEVELOPER_CONTACT_ACTIVE_THRESHOLD??1500),authority:async(name,method,input)=>(await guardFor(name)).populationAction(method,input)});await (await guardFor('active-user-v1/census')).populationAction('baseline');
 const assets={fetch:async request=>{
   let path;try{const pathname=decodeURIComponent(new URL(request.url).pathname);const base=resolve('.output/public');path=resolve(base,pathname==='/'?'index.html':'.'+pathname);if(!path.startsWith(base+'/'))return new Response('Not found',{status:404});}catch{return new Response('Not found',{status:404});}
   try{const data=await readFile(path);const type={'.html':'text/html; charset=utf-8','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8'}[extname(path)]||'application/octet-stream';return new Response(data,{headers:{'Content-Type':type,'Cache-Control':'no-cache'}});}catch(error){if(['ENOENT','EISDIR'].includes(error.code))return new Response('Not found',{status:404});throw error;}
 }};
 await mkdir(join(directory,'mcp'),{recursive:true,mode:0o700});const mcpMap=new Map();
 const mcp=mcpAuthorities(shard=>{if(!mcpMap.has(shard)){const metadata=new SqliteMetadata(join(directory,'mcp',`mcp-auth-v1-64-${shard}.sqlite`));const controller=new McpShardController({metadata,config,shard,accounts,repository});metadata.onAlarm=()=>controller.cleanup();metadata.getAlarm().then(time=>{if(time)metadata.arm(time);});mcpMap.set(shard,{metadata,controller});}return mcpMap.get(shard).controller;});
 await mkdir(join(directory,'federation'),{recursive:true,mode:0o700});const federationMap=new Map();
 // client-id-metadata.v1 (CLIENT_METADATA_ENABLED): DNS-pinned public egress, process-wide plus durable ABUSE budgets,
 // and the administrator block list (read lazily; an unreadable store fails closed). An injected CLIENT_METADATA_FETCH
 // must give equivalent guarantees.
 const clientDirectory=federationClientDirectory(config,clientMetadataEnabled(config)?{fetch:typeof config.CLIENT_METADATA_FETCH==='function'?config.CLIENT_METADATA_FETCH:createNodeClientMetadataFetch(),limiter:abuse,blocked:host=>adminClientBlocked(adminStore,host)}:{});
 const federation=federationAuthority({config,repository,directory:clientDirectory,shard:owner=>{if(!federationMap.has(owner)){const metadata=new SqliteMetadata(join(directory,'federation',`${FEDERATION_LAYOUT}-${owner}.sqlite`));const implementation=new FederationController({...federationControllerOptions({config,repository,accounts,owner}),metadata:federationMetadata(metadata)});metadata.onAlarm=async()=>{const result=await implementation.cleanup();if(result.remaining)await metadata.setAlarm(result.nextAlarmAt);};metadata.getAlarm().then(time=>{if(time)metadata.arm(time);});const controller=new Proxy(implementation,{get:(target,method)=>typeof target[method]==='function'?async(...args)=>{const result=await target[method](...args);if(!['ready','manifest','cleanup'].includes(method)&&!await metadata.getAlarm())await metadata.setAlarm(Date.now()+600000);return result;}:target[method]});federationMap.set(owner,{metadata,controller});}return federationMap.get(owner).controller;}});
 const brokeringDb=brokeringEnabled(config)?new SqliteMetadata(join(directory,'federation','brokering-v1.sqlite')):null,brokering=brokeringDb?{enabled:true,...brokeringKeys({issuer:config.APP_ORIGIN,secret:config.KEY_ENCRYPTION_KEY,metadata:federationMetadata(brokeringDb)})}:undefined;
 // The pre-owner authorization-entry store, sharded by entry ID like the MCP stores (one SQLite file per shard, each
 // pruned by its own alarm); null unless FEDERATION_ENTRY_ENABLED. packages/runtime/http.mjs mounts the provider
 // session-ending hook, so end-session is offered.
 const entryShards=new Map();let federationEntryStore=null;
 if(config.FEDERATION_ENTRY_ENABLED==='true'){
  const shardOf=shard=>{if(!entryShards.has(shard)){const db=new SqliteMetadata(join(directory,'federation',`authorization-entries-v2-${ENTRY_SHARDS}-${shard}.sqlite`));db.onAlarm=async()=>{const next=await federationEntriesCleanup(entries,Date.now(),shard);if(next)await db.setAlarm(next);};db.getAlarm().then(time=>{if(time)db.arm(time);});entryShards.set(shard,{db,store:federationMetadata(db)});}return entryShards.get(shard);};
  const entries=federationEntries({config,store:shard=>shardOf(shard).store,authority:federation,endSession:true,directory:clientDirectory});
  // Creation writes the caller's budget shard and the entry's shard; both arm their cleanup alarm.
  const arm=async shard=>{const {db}=shardOf(shard);if(!await db.getAlarm())await db.setAlarm(Date.now()+600000);};
  const create=entries.create.bind(entries);entries.create=async(input,context={})=>{const result=await create(input,context);await arm(entryShard(result.entryId));await arm(await remoteShard(crypto,context.remote));if(entries.metadataClient(input?.clientId))await arm(entryShard(await digest(crypto,`entry-client-host\0${clientSite(metadataClientHost(input.clientId))}`)));return result;};
  federationEntryStore=entries;
 }
 const adminDb=new SqliteMetadata(join(directory,'admin.sqlite'));adminStore=new AdminStorage(adminDb);
 // Lifecycle scheduler: a six-hourly sweep (the Worker cron cadence) plus its own continuation alarm.
 // Opening each swept account re-arms its persisted alarm, so abandoned accounts wake after a restart.
 let lifecycleDb=null,lifecycleTimers=[];
 if(lifecycleMode(config)!=='off'){
  lifecycleDb=new SqliteMetadata(join(directory,'lifecycle.sqlite'));const sweep=new LifecycleSweep({metadata:lifecycleDb,repository,accounts,config});const run=trigger=>sweep.run({trigger}).catch(()=>{});
  lifecycleDb.onAlarm=()=>run('alarm');{const alarm=await lifecycleDb.getAlarm();if(alarm)lifecycleDb.arm(alarm);}
  lifecycleTimers=[setTimeout(()=>run('startup'),60000),setInterval(()=>run('cron'),6*3600000)];for(const timer of lifecycleTimers)timer.unref();
 }
 linkedLimits={consume:(key,window)=>abuse.consume('linked-v1:'+key,window)};
 return {repository,deviceRequests,linkedLimits,linkedPollLimits,accounts,abuse,population,assets,mcp,federation,brokering,federationEntries:federationEntryStore,adminStore,catalog,close(){brokeringDb?.close();for(const timer of lifecycleTimers)clearTimeout(timer);lifecycleDb?.close();catalogDb.close();adminDb.close();for(const {db}of entryShards.values())db.close();identities.close();deviceDb.close();for(const {metadata}of accountMap.values())metadata.close();for(const {metadata}of guardMap.values())metadata.close();for(const {metadata}of mcpMap.values())metadata.close();for(const {metadata}of federationMap.values())metadata.close();}};
}

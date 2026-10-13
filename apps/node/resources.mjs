import {PlanCatalogRegistry,cachedCatalogPort} from '../../packages/billing/registry.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, unlink, stat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, extname } from 'node:path';
import {nodeSqlPort} from '../../packages/search/index.mjs';
import { IdentityRepository, FixedWindowGuard, AccountController } from '../../packages/runtime/accounts.mjs';
import {McpShardController,mcpAuthorities} from '../../packages/mcp/runtime.mjs';
import {FederationController,federationMetadata} from '../../packages/federation/runtime.mjs';
import {federationAuthority,federationControllerOptions,FEDERATION_LAYOUT,federationEpoch} from '../../packages/runtime/federation.mjs';

export class SerialGate {
 constructor(){this.tail=Promise.resolve();}
 async run(operation){const previous=this.tail;let release;this.tail=new Promise(r=>release=r);await previous;try{return await operation();}finally{release();}}
}
export class SqliteMetadata {
 constructor(file){this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');this.gate=new SerialGate();this.timer=null;this.sql=nodeSqlPort(this.db);}
 raw(){const self=this;return {
  get:async key=>{const row=self.db.prepare('SELECT value FROM records WHERE key=?').get(key);return row?JSON.parse(row.value):undefined;},
  put:async(key,value)=>{if(typeof key==='object'){for(const [k,v]of Object.entries(key))await self.raw().put(k,v);return;}self.db.prepare('INSERT INTO records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));},
  delete:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])self.db.prepare('DELETE FROM records WHERE key=?').run(key);},
  list:async({prefix='',startAfter='',limit=100000}={})=>new Map(self.db.prepare('SELECT key,value FROM records WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?').all(prefix,prefix+'\uffff',startAfter,limit).map(row=>[row.key,JSON.parse(row.value)])),
  setAlarm:async time=>{await self.raw().put('@alarm',time);self.arm(time);}
 };}
 get(key){return this.gate.run(()=>this.raw().get(key));}
 put(key,value){return this.gate.run(()=>this.raw().put(key,value));}
 delete(key){return this.gate.run(()=>this.raw().delete(key));}
 list(options){return this.gate.run(()=>this.raw().list(options));}
 deleteAll(){return this.gate.run(()=>this.db.exec('DELETE FROM records'));}
 async transaction(operation){return this.gate.run(async()=>{this.db.exec('BEGIN IMMEDIATE');try{const value=await operation(this.raw());this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}});}
 async setAlarm(time){await this.put('@alarm',time);this.arm(time);}
 getAlarm(){return this.get('@alarm');}
 arm(time){clearTimeout(this.timer);if(!this.onAlarm)return;this.timer=setTimeout(async()=>{try{const claimed=await this.transaction(async tx=>{if(await tx.get('@alarm')!==time)return false;await tx.delete('@alarm');return true;});if(!claimed)return;await this.onAlarm();}catch{const next=await this.getAlarm();if(!next)await this.setAlarm(Date.now()+60000);else this.arm(next);}},Math.min(2147483647,Math.max(1,time-Date.now())));this.timer.unref();}
 close(){clearTimeout(this.timer);this.db.close();}
}
export class FileBucket {
 constructor(directory){this.directory=directory;}
 path(key){return join(this.directory,createHash('sha256').update(key).digest('hex'));}
 async put(key,content){await mkdir(this.directory,{recursive:true,mode:0o700});const destination=this.path(key),temporary=destination+'.'+randomUUID();const bytes=typeof content==='string'?content:new Uint8Array(content);try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temporary,destination);}catch(error){try{await unlink(temporary);}catch{}throw error;}const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}return {key};}
 async get(key){const path=this.path(key);try{const size=(await stat(path)).size;return {size,arrayBuffer:async()=>{const b=await readFile(path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);},text:async()=>(await readFile(path)).toString('utf8'),json:async()=>JSON.parse((await readFile(path)).toString('utf8'))};}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 async delete(keys){let deleted=false;for(const key of Array.isArray(keys)?keys:[keys])try{await unlink(this.path(key));deleted=true;}catch(error){if(error.code!=='ENOENT')throw error;}if(deleted){const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}}}
}
export async function nodeResources({directory,config}){
 await mkdir(directory,{recursive:true,mode:0o700});await mkdir(join(directory,'accounts'),{recursive:true,mode:0o700});await mkdir(join(directory,'abuse'),{recursive:true,mode:0o700});
 const catalogDb=new SqliteMetadata(join(directory,'plan-catalog.sqlite')),catalogRegistry=new PlanCatalogRegistry({metadata:catalogDb,config}),catalog=cachedCatalogPort(catalogRegistry);
 const identities=new SqliteMetadata(join(directory,'identities.sqlite'));const repository=new IdentityRepository({metadata:identities});
 const deviceDb=new SqliteMetadata(join(directory,'devices.sqlite'));const deviceRepo=new IdentityRepository({metadata:deviceDb});
 const deviceRequests={create:r=>deviceRepo.createDevice(r),get:id=>deviceRepo.getDevice(id),findByUserCode:code=>deviceRepo.findDeviceByCode(code),compareAndSwap:(id,revision,r)=>deviceRepo.compareAndSwapDevice(id,revision,r)};
 const blobs=new FileBucket(join(directory,'blobs')),archives=new FileBucket(join(directory,'archives'));const accountMap=new Map(),guardMap=new Map();
 const abuse={consume:async(name,limits)=>{const file=createHash('sha256').update(name).digest('hex');if(!guardMap.has(file)){const metadata=new SqliteMetadata(join(directory,'abuse',file+'.sqlite'));const guard=new FixedWindowGuard({metadata});metadata.onAlarm=()=>guard.alarm();guardMap.set(file,{metadata,guard});}return guardMap.get(file).guard.consume(limits);}};
 const accounts={get:id=>{
   if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid account identifier');
   if(!accountMap.has(id)){const metadata=new SqliteMetadata(join(directory,'accounts',id+'.sqlite'));const controller=new AccountController({metadata,gate:new SerialGate(),blobs,archives,config:{...config,BILLING_CATALOG:catalog,FEDERATION_IDENTITY_CHECK:async(owner,epoch)=>{const account=await repository.get(owner);return account?.status==='active'&&await federationEpoch(account)===epoch;},WORK_AUTHORITY:abuse,CONVERSATION_ACCOUNT:owner=>accounts.get(owner)},sql:metadata.sql});metadata.onAlarm=()=>controller.alarm();metadata.getAlarm().then(time=>{if(time)metadata.arm(time);});accountMap.set(id,{metadata,controller});}return accountMap.get(id).controller;
 }};

 const assets={fetch:async request=>{
   let path;try{const pathname=decodeURIComponent(new URL(request.url).pathname);const base=resolve('.output/public');path=resolve(base,pathname==='/'?'index.html':'.'+pathname);if(!path.startsWith(base+'/'))return new Response('Not found',{status:404});}catch{return new Response('Not found',{status:404});}
   try{const data=await readFile(path);const type={'.html':'text/html; charset=utf-8','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8'}[extname(path)]||'application/octet-stream';return new Response(data,{headers:{'Content-Type':type,'Cache-Control':'no-cache'}});}catch(error){if(['ENOENT','EISDIR'].includes(error.code))return new Response('Not found',{status:404});throw error;}
 }};
 await mkdir(join(directory,'mcp'),{recursive:true,mode:0o700});const mcpMap=new Map();
 const mcp=mcpAuthorities(shard=>{if(!mcpMap.has(shard)){const metadata=new SqliteMetadata(join(directory,'mcp',`mcp-auth-v1-64-${shard}.sqlite`));const controller=new McpShardController({metadata,config,shard,accounts,repository});metadata.onAlarm=()=>controller.cleanup();metadata.getAlarm().then(time=>{if(time)metadata.arm(time);});mcpMap.set(shard,{metadata,controller});}return mcpMap.get(shard).controller;});
 await mkdir(join(directory,'federation'),{recursive:true,mode:0o700});const federationMap=new Map();
 const federation=federationAuthority({config,repository,shard:owner=>{if(!federationMap.has(owner)){const metadata=new SqliteMetadata(join(directory,'federation',`${FEDERATION_LAYOUT}-${owner}.sqlite`));const implementation=new FederationController({...federationControllerOptions({config,repository,accounts,owner}),metadata:federationMetadata(metadata)});metadata.onAlarm=async()=>{const result=await implementation.cleanup();if(result.remaining)await metadata.setAlarm(result.nextAlarmAt);};metadata.getAlarm().then(time=>{if(time)metadata.arm(time);});const controller=new Proxy(implementation,{get:(target,method)=>typeof target[method]==='function'?async(...args)=>{const result=await target[method](...args);if(!['ready','manifest','cleanup'].includes(method)&&!await metadata.getAlarm())await metadata.setAlarm(Date.now()+600000);return result;}:target[method]});federationMap.set(owner,{metadata,controller});}return federationMap.get(owner).controller;}});
 return {repository,deviceRequests,accounts,abuse,assets,mcp,federation,catalog,close(){catalogDb.close();identities.close();deviceDb.close();for(const {metadata}of accountMap.values())metadata.close();for(const {metadata}of guardMap.values())metadata.close();for(const {metadata}of mcpMap.values())metadata.close();for(const {metadata}of federationMap.values())metadata.close();}};
}

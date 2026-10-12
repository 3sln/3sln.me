import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, unlink, stat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, extname } from 'node:path';
import { IdentityRepository, FixedWindowGuard, AccountController } from '../../packages/runtime/accounts.mjs';

export class SerialGate {
 constructor(){this.tail=Promise.resolve();}
 async run(operation){const previous=this.tail;let release;this.tail=new Promise(r=>release=r);await previous;try{return await operation();}finally{release();}}
}
export class SqliteMetadata {
 constructor(file){this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');this.gate=new SerialGate();this.timer=null;}
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
 arm(time){clearTimeout(this.timer);if(!this.onAlarm)return;this.timer=setTimeout(async()=>{try{await this.onAlarm();}catch{this.arm(Date.now()+60000);}},Math.min(2147483647,Math.max(1,time-Date.now())));this.timer.unref();}
 close(){clearTimeout(this.timer);this.db.close();}
}
export class FileBucket {
 constructor(directory){this.directory=directory;}
 path(key){return join(this.directory,createHash('sha256').update(key).digest('hex'));}
 async put(key,content){await mkdir(this.directory,{recursive:true,mode:0o700});const destination=this.path(key),temporary=destination+'.'+randomUUID();const bytes=typeof content==='string'?content:new Uint8Array(content);const file=await open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temporary,destination);const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}return {key};}
 async get(key){const path=this.path(key);try{const size=(await stat(path)).size;return {size,arrayBuffer:async()=>{const b=await readFile(path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);},text:async()=>(await readFile(path)).toString('utf8'),json:async()=>JSON.parse((await readFile(path)).toString('utf8'))};}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])try{await unlink(this.path(key));}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export async function nodeResources({directory,config}){
 await mkdir(directory,{recursive:true,mode:0o700});await mkdir(join(directory,'accounts'),{recursive:true,mode:0o700});
 const identities=new SqliteMetadata(join(directory,'identities.sqlite'));const repository=new IdentityRepository({metadata:identities});
 const deviceDb=new SqliteMetadata(join(directory,'devices.sqlite'));const deviceRepo=new IdentityRepository({metadata:deviceDb});
 const deviceRequests={create:r=>deviceRepo.createDevice(r),get:id=>deviceRepo.getDevice(id),findByUserCode:code=>deviceRepo.findDeviceByCode(code),compareAndSwap:(id,revision,r)=>deviceRepo.compareAndSwapDevice(id,revision,r)};
 const blobs=new FileBucket(join(directory,'blobs')),archives=new FileBucket(join(directory,'archives'));const accountMap=new Map(),guardMap=new Map();
 const accounts={get:id=>{
   if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid account identifier');
   if(!accountMap.has(id)){const metadata=new SqliteMetadata(join(directory,'accounts',id+'.sqlite'));const controller=new AccountController({metadata,gate:new SerialGate(),blobs,archives,config});metadata.onAlarm=()=>controller.alarm();metadata.getAlarm().then(time=>{if(time)metadata.arm(time);});accountMap.set(id,{metadata,controller});}return accountMap.get(id).controller;
 }};
 const abuse={consume:async(name,limits)=>{const file=createHash('sha256').update(name).digest('hex');if(!guardMap.has(file)){await mkdir(join(directory,'abuse'),{recursive:true,mode:0o700});const metadata=new SqliteMetadata(join(directory,'abuse',file+'.sqlite'));const guard=new FixedWindowGuard({metadata});metadata.onAlarm=()=>guard.alarm();guardMap.set(file,{metadata,guard});}return guardMap.get(file).guard.consume(limits);}};
 const assets={fetch:async request=>{
   let path;try{const pathname=decodeURIComponent(new URL(request.url).pathname);const base=resolve('.output/public');path=resolve(base,pathname==='/'?'index.html':'.'+pathname);if(!path.startsWith(base+'/'))return new Response('Not found',{status:404});}catch{return new Response('Not found',{status:404});}
   try{const data=await readFile(path);const type={'.html':'text/html; charset=utf-8','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8'}[extname(path)]||'application/octet-stream';return new Response(data,{headers:{'Content-Type':type,'Cache-Control':'no-cache'}});}catch(error){if(['ENOENT','EISDIR'].includes(error.code))return new Response('Not found',{status:404});throw error;}
 }};
 return {repository,deviceRequests,accounts,abuse,assets,close(){identities.close();deviceDb.close();for(const {metadata}of accountMap.values())metadata.close();for(const {metadata}of guardMap.values())metadata.close();}};
}

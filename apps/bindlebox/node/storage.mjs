import {DatabaseSync} from 'node:sqlite';
import {serialize,deserialize} from 'node:v8';
import {nextWake} from '../worker/storage.mjs';
// One serialized SQLite connection per mailbox; reads queue behind the transaction as well, so an async
// transaction cannot leak uncommitted state through another ngin dispatch. BLOBs retain typed message bytes.
export class SqliteMailboxStore {
 constructor(file,{clock={now:()=>Date.now()}}={}){this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY,value BLOB NOT NULL)');this.tail=Promise.resolve();this.clock=clock;this.closed=false;}
 gate(work){const result=this.tail.then(()=>{if(this.closed)throw new Error('Mailbox closed');return work();});this.tail=result.catch(()=>{});return result;}
 raw(){return {get:async key=>{const row=this.db.prepare('SELECT value FROM records WHERE key=?').get(key);return row?deserialize(row.value):undefined;},put:async(key,value)=>{this.db.prepare('INSERT INTO records VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,serialize(value));},delete:async key=>{this.db.prepare('DELETE FROM records WHERE key=?').run(key);},list:async({prefix=''}={})=>new Map(this.db.prepare('SELECT key,value FROM records WHERE key>=? AND key<? ORDER BY key').all(prefix,prefix+'\uffff').map(row=>[row.key,deserialize(row.value)]))};}
 get(key){return this.gate(()=>this.raw().get(key));}list(options){return this.gate(()=>this.raw().list(options));}
 put(key,value){return this.transaction(tx=>tx.put(key,value));}delete(key){return this.transaction(tx=>tx.delete(key));}
 transaction(work){return this.gate(async()=>{this.db.exec('BEGIN IMMEDIATE');try{const tx=this.raw(),value=await work(tx),at=await nextWake(tx,this.clock.now());if(at===null)await tx.delete('shell:alarm');else await tx.put('shell:alarm',at);this.db.exec('COMMIT');this.arm(at);return value;}catch(error){this.db.exec('ROLLBACK');throw error;}});}
 async recover(){const at=await this.get('shell:alarm');if(at)this.arm(at);else await this.transaction(()=>{});}
 arm(at){clearTimeout(this.timer);if(this.closed||at===null||!this.onAlarm)return;this.timer=setTimeout(async()=>{let failed=false;try{await this.onAlarm();}catch{failed=true;}finally{if(!this.closed){const next=await this.get('shell:alarm');this.arm(failed?Math.max(this.clock.now()+60000,next??0):next??null);}}},Math.max(1,Math.min(2147483647,at-this.clock.now())));this.timer.unref();}
 async close(){await this.tail;this.closed=true;clearTimeout(this.timer);this.db.close();}
}

import {StorageError} from '../storage/policy.mjs';
const publicMessage=({bytes,blobRef,...record})=>record;
const encode=value=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function decode(value){try{if(typeof value!=='string'||value.length>4096)throw new Error();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));}catch{throw new StorageError('invalid_args','Invalid page cursor.');}}
/** SQL catalogs provide bounded keyset pages; payloads stay in object storage.
 * SQL is an injected resource supported by SQLite DOs and Node SQLite. */
export class AccountItemIndex {
 constructor(sql){this.sql=sql;sql.exec('CREATE TABLE IF NOT EXISTS inbox_catalog (id TEXT PRIMARY KEY, owner TEXT NOT NULL, received_at INTEGER NOT NULL, collection TEXT NOT NULL, unread INTEGER NOT NULL, quarantined INTEGER NOT NULL, record TEXT NOT NULL)');sql.exec('CREATE INDEX IF NOT EXISTS inbox_owner_time ON inbox_catalog(owner,received_at DESC,id DESC)');sql.exec('CREATE INDEX IF NOT EXISTS inbox_collection_time ON inbox_catalog(owner,collection,received_at DESC,id DESC)');sql.exec('CREATE INDEX IF NOT EXISTS inbox_unread_time ON inbox_catalog(owner,unread,received_at DESC,id DESC)');sql.exec('CREATE INDEX IF NOT EXISTS inbox_quarantine_time ON inbox_catalog(owner,quarantined,received_at DESC,id DESC)');sql.exec('CREATE TABLE IF NOT EXISTS hosted_catalog (resource TEXT NOT NULL, object_key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(resource,object_key))');}
 upsert(message){this.sql.exec('INSERT INTO inbox_catalog(id,owner,received_at,collection,unread,quarantined,record) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET collection=excluded.collection,unread=excluded.unread,quarantined=excluded.quarantined,record=excluded.record',message.id,message.owner,message.receivedAt??0,message.collection??'',message.readAt==null?1:0,message.quarantined?1:0,JSON.stringify(publicMessage(message)));}
 remove(id){this.sql.exec('DELETE FROM inbox_catalog WHERE id=?',id);}
 get(id){const row=[...this.sql.exec('SELECT record FROM inbox_catalog WHERE id=?',id)][0];return row?JSON.parse(row.record):null;}
 page(owner,{collection,unread,quarantined,limit=100,cursor}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||collection!==undefined&&(typeof collection!=='string'||collection.length>200)||unread!==undefined&&typeof unread!=='boolean'||quarantined!==undefined&&typeof quarantined!=='boolean')throw new StorageError('invalid_args','Invalid inbox page.');
  const scope=JSON.stringify([owner,collection??null,unread??null,quarantined??null]);let boundary;
  if(cursor){boundary=decode(cursor);if(boundary.scope!==scope||!Number.isSafeInteger(boundary.at)||typeof boundary.id!=='string'||boundary.id.length>128)throw new StorageError('invalid_args','Page cursor does not match this view.');}
  const where=['owner=?'],args=[owner];if(collection!==undefined){where.push('collection=?');args.push(collection);}if(unread!==undefined){where.push('unread=?');args.push(unread?1:0);}if(quarantined!==undefined){where.push('quarantined=?');args.push(quarantined?1:0);}if(boundary){where.push('(received_at<? OR (received_at=? AND id<?))');args.push(boundary.at,boundary.at,boundary.id);}
  const rows=[...this.sql.exec(`SELECT id,received_at,record FROM inbox_catalog WHERE ${where.join(' AND ')} ORDER BY received_at DESC,id DESC LIMIT ?`,...args,limit+1)];
  const shown=rows.slice(0,limit),last=shown.at(-1);return {items:shown.map(r=>JSON.parse(r.record)),cursor:rows.length>limit?encode({scope,at:last.received_at,id:last.id}):null};
 }
 upsertObject(resource,object){const {blobRef,...record}=object;this.sql.exec('INSERT INTO hosted_catalog(resource,object_key,record) VALUES(?,?,?) ON CONFLICT(resource,object_key) DO UPDATE SET record=excluded.record',resource,object.key,JSON.stringify(record));}
 removeObject(resource,key){this.sql.exec('DELETE FROM hosted_catalog WHERE resource=? AND object_key=?',resource,key);}
 objectPage(resource,{prefix='',limit=100,cursor}={}){
  if(typeof prefix!=='string'||prefix.length>1024||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new StorageError('invalid_args','Invalid object page.');let after='';
  if(cursor){const c=decode(cursor);if(c.resource!==resource||c.prefix!==prefix||typeof c.after!=='string'||c.after.length>1024)throw new StorageError('invalid_args','Invalid object page cursor.');after=c.after;}
  const rows=[...this.sql.exec('SELECT object_key,record FROM hosted_catalog WHERE resource=? AND object_key>=? AND object_key<? AND object_key>? ORDER BY object_key LIMIT ?',resource,prefix,prefix+'\u{10ffff}',after,limit+1)];
  const shown=rows.slice(0,limit);return {objects:shown.map(row=>JSON.parse(row.record)),cursor:rows.length>limit?encode({resource,prefix,after:shown.at(-1).object_key}):null};
 }
}

import {publicMessageMetadata as publicMessage} from '../messaging/message-metadata.mjs';
import {normalizeIncomingFilter,incomingSort,normalizeIncomingUpdate} from './message-views.mjs';
import {StorageError} from '../storage/policy.mjs';
import {migrateTags,changeTags} from '../messaging/tags.mjs';
const encode=value=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function decode(value){try{if(typeof value!=='string'||value.length>4096)throw new Error();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));}catch{throw new StorageError('invalid_args','Invalid page cursor.');}}
/** SQL catalogs provide bounded keyset pages; payloads stay in object storage.
 * SQL is an injected resource supported by SQLite DOs and Node SQLite. */
export class AccountItemIndex {
 constructor(sql){this.sql=sql;sql.exec('CREATE TABLE IF NOT EXISTS inbox_catalog (id TEXT PRIMARY KEY, owner TEXT NOT NULL, received_at INTEGER NOT NULL, collection TEXT NOT NULL, unread INTEGER NOT NULL, quarantined INTEGER NOT NULL, record TEXT NOT NULL)');sql.exec('CREATE INDEX IF NOT EXISTS inbox_owner_time ON inbox_catalog(owner,received_at DESC,id DESC)');sql.exec('CREATE INDEX IF NOT EXISTS inbox_collection_time ON inbox_catalog(owner,collection,received_at DESC,id DESC)');sql.exec('CREATE INDEX IF NOT EXISTS inbox_unread_time ON inbox_catalog(owner,unread,received_at DESC,id DESC)');sql.exec('CREATE INDEX IF NOT EXISTS inbox_quarantine_time ON inbox_catalog(owner,quarantined,received_at DESC,id DESC)');this.initIncoming();sql.exec('CREATE TABLE IF NOT EXISTS hosted_catalog (resource TEXT NOT NULL, object_key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(resource,object_key))');}
 upsert(message){message=migrateTags(message);this.sql.exec('INSERT INTO inbox_catalog(id,owner,received_at,collection,unread,quarantined,record) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET collection=excluded.collection,unread=excluded.unread,quarantined=excluded.quarantined,record=excluded.record',message.id,message.owner,message.receivedAt??0,message.collection??'',message.readAt==null?1:0,message.quarantined?1:0,JSON.stringify(publicMessage(message)));this.projectIncoming(message);}
 remove(id){const prior=[...this.sql.exec('SELECT owner,item_id,unread FROM incoming_members WHERE id=?',id)][0];this.sql.exec('DELETE FROM inbox_catalog WHERE id=?',id);this.sql.exec('DELETE FROM incoming_members WHERE id=?',id);if(prior)this.refreshIncoming(prior.owner,prior.item_id,-1,-prior.unread);}
 get(id){const row=[...this.sql.exec('SELECT record FROM inbox_catalog WHERE id=?',id)][0];return row?JSON.parse(row.record):null;}
 page(owner,{collection,unread,quarantined,limit=100,cursor}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||collection!==undefined&&(typeof collection!=='string'||collection.length>200)||unread!==undefined&&typeof unread!=='boolean'||quarantined!==undefined&&typeof quarantined!=='boolean')throw new StorageError('invalid_args','Invalid inbox page.');
  const scope=JSON.stringify([owner,collection??null,unread??null,quarantined??null]);let boundary;
  if(cursor){boundary=decode(cursor);if(boundary.scope!==scope||!Number.isSafeInteger(boundary.at)||typeof boundary.id!=='string'||boundary.id.length>128)throw new StorageError('invalid_args','Page cursor does not match this view.');}
  const where=['owner=?'],args=[owner];if(collection!==undefined){where.push('collection=?');args.push(collection);}if(unread!==undefined){where.push('unread=?');args.push(unread?1:0);}if(quarantined!==undefined){where.push('quarantined=?');args.push(quarantined?1:0);}if(boundary){where.push('(received_at<? OR (received_at=? AND id<?))');args.push(boundary.at,boundary.at,boundary.id);}
  const rows=[...this.sql.exec(`SELECT id,received_at,record FROM inbox_catalog WHERE ${where.join(' AND ')} ORDER BY received_at DESC,id DESC LIMIT ?`,...args,limit+1)];
  const shown=rows.slice(0,limit),last=shown.at(-1);return {items:shown.map(r=>JSON.parse(r.record)),cursor:rows.length>limit?encode({scope,at:last.received_at,id:last.id}):null};
 }
 initIncoming(){
  this.sql.exec('CREATE TABLE IF NOT EXISTS incoming_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS incoming_members (id TEXT PRIMARY KEY,owner TEXT NOT NULL,item_id TEXT NOT NULL,received_at INTEGER NOT NULL,unread INTEGER NOT NULL,record TEXT NOT NULL)');
  if(![...this.sql.exec('PRAGMA table_info(incoming_members)')].some(column=>column.name==='sequence'))this.sql.exec('ALTER TABLE incoming_members ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0');
  this.sql.exec('CREATE TABLE IF NOT EXISTS incoming_preferences (owner TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(owner,id))');
  this.sql.exec('CREATE INDEX IF NOT EXISTS incoming_member_sequence ON incoming_members(owner,item_id,sequence DESC)');
  this.sql.exec('CREATE INDEX IF NOT EXISTS incoming_member_group ON incoming_members(owner,item_id,received_at DESC,id DESC)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS incoming_catalog (id TEXT NOT NULL,owner TEXT NOT NULL,type TEXT NOT NULL,received_at INTEGER NOT NULL,activity_at INTEGER NOT NULL,unread INTEGER NOT NULL,classification TEXT NOT NULL,item_count INTEGER NOT NULL,unread_count INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(owner,id))');
  for(const time of ['received_at','activity_at']){this.sql.exec(`CREATE INDEX IF NOT EXISTS incoming_${time} ON incoming_catalog(owner,${time} DESC,id DESC)`);this.sql.exec(`CREATE INDEX IF NOT EXISTS incoming_type_${time} ON incoming_catalog(owner,type,${time} DESC,id DESC)`);this.sql.exec(`CREATE INDEX IF NOT EXISTS incoming_read_${time} ON incoming_catalog(owner,unread,${time} DESC,id DESC)`);}
  this.sql.exec('CREATE TABLE IF NOT EXISTS incoming_tags (owner TEXT NOT NULL,tag TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(owner,tag,item_id))');
  this.sql.exec('CREATE INDEX IF NOT EXISTS incoming_tags_item ON incoming_tags(owner,item_id)');
  this.sql.exec('INSERT OR IGNORE INTO incoming_state(key,value) VALUES(?,?)','revision','0');
  this.sql.exec('INSERT OR IGNORE INTO incoming_state(key,value) VALUES(?,?)','cursor-key',encode([...crypto.getRandomValues(new Uint8Array(32))]));
 }
 incomingState(key){return [...this.sql.exec('SELECT value FROM incoming_state WHERE key=?',key)][0]?.value;}
 setIncomingState(key,value){this.sql.exec('INSERT INTO incoming_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(value));}
 migrateIncoming(limit=200){
  if(this.incomingState('ready')==='1')return this.migrateIncomingTags(limit);
  const after=this.incomingState('migration')??'',rows=[...this.sql.exec('SELECT id,record FROM inbox_catalog WHERE id>? ORDER BY id LIMIT ?',after,limit)];
  for(const row of rows)this.projectIncoming(JSON.parse(row.record));
  if(rows.length<limit)this.setIncomingState('ready','1');else this.setIncomingState('migration',rows.at(-1).id);
  return rows.length<limit;
 }
 // Tag model v1: re-project legacy members in bounded batches so system tags reach the tag index.
 migrateIncomingTags(limit=200){
  if(this.incomingState('tag-model')==='1')return true;
  const after=this.incomingState('tag-migration')??'',rows=[...this.sql.exec('SELECT id,record FROM incoming_members WHERE id>? ORDER BY id LIMIT ?',after,limit)];
  for(const row of rows)this.projectIncoming(JSON.parse(row.record));
  if(rows.length<limit)this.setIncomingState('tag-model','1');else this.setIncomingState('tag-migration',rows.at(-1).id);
  return rows.length<limit;
 }
 projectIncoming(message){
  message=migrateTags(message);
  const c=message.conversation,conversation=c&&typeof c.id==='string'&&typeof c.source?.origin==='string'&&typeof c.source?.owner==='string';
  const itemId=conversation?'conversation:'+encode([c.source.origin,c.source.owner,c.id]):message.id;
  const prior=[...this.sql.exec('SELECT owner,item_id,unread,sequence,record FROM incoming_members WHERE id=?',message.id)][0],record=JSON.stringify(publicMessage(message));
  if(prior?.record===record&&prior.item_id===itemId&&prior.owner===message.owner)return;
  const same=prior&&prior.item_id===itemId&&prior.owner===message.owner;let sequence=prior?.sequence??0;
  if(conversation){const prefs=this.incomingPreferences(message.owner,itemId,message);if(!same){sequence=prefs.generation+1;this.sql.exec('UPDATE incoming_preferences SET generation=? WHERE owner=? AND id=?',sequence,message.owner,itemId);}}
  this.sql.exec('INSERT INTO incoming_members(id,owner,item_id,received_at,unread,record,sequence) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,item_id=excluded.item_id,received_at=excluded.received_at,unread=excluded.unread,record=excluded.record,sequence=excluded.sequence',message.id,message.owner,itemId,message.receivedAt??0,message.readAt==null?1:0,record,sequence);
  if(prior&&!same)this.refreshIncoming(prior.owner,prior.item_id,-1,-prior.unread);
  this.refreshIncoming(message.owner,itemId,same?0:1,(message.readAt==null?1:0)-(same?prior.unread:0));
 }
 refreshIncoming(owner,id,countDelta=0,unreadDelta=0){
  const last=[...this.sql.exec('SELECT record FROM incoming_members WHERE owner=? AND item_id=? ORDER BY received_at DESC,id DESC LIMIT 1',owner,id)][0];
  this.sql.exec('DELETE FROM incoming_tags WHERE owner=? AND item_id=?',owner,id);
  if(!last)this.sql.exec('DELETE FROM incoming_catalog WHERE owner=? AND id=?',owner,id);
  else{
   const message=JSON.parse(last.record),previous=[...this.sql.exec('SELECT item_count,unread_count FROM incoming_catalog WHERE owner=? AND id=?',owner,id)][0],first=[...this.sql.exec('SELECT received_at FROM incoming_members WHERE owner=? AND item_id=? ORDER BY received_at,id LIMIT 1',owner,id)][0].received_at,unreadCount=(previous?.unread_count??0)+unreadDelta,stats={first,last:message.receivedAt??0,count:(previous?.item_count??0)+countDelta,unread:unreadCount>0?1:0};
   const type=id.startsWith('conversation:')?'conversation':'message',prefs=type==='conversation'?this.incomingPreferences(owner,id,message):null;let unread=stats.unread,readAt=stats.unread?null:message.readAt;
   if(prefs?.record.readMode==='unread'){unread=1;readAt=null;}
   if(prefs?.record.readMode==='through'){const latest=[...this.sql.exec('SELECT sequence FROM incoming_members WHERE owner=? AND item_id=? ORDER BY sequence DESC LIMIT 1',owner,id)][0].sequence;unread=latest>prefs.record.readThrough?1:0;readAt=unread?null:prefs.record.readAt;}
   const record={...message,id,type,receivedAt:stats.first,activityAt:stats.last,readAt,...type==='conversation'?{messageId:message.id,eventCount:stats.count,tags:prefs.record.tags,classification:prefs.record.classification,organizationRevision:prefs.revision,activityRevision:prefs.generation}:{}};
   this.sql.exec('INSERT INTO incoming_catalog(id,owner,type,received_at,activity_at,unread,classification,item_count,unread_count,record) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET type=excluded.type,received_at=excluded.received_at,activity_at=excluded.activity_at,unread=excluded.unread,classification=excluded.classification,item_count=excluded.item_count,unread_count=excluded.unread_count,record=excluded.record',id,owner,type,stats.first,stats.last,unread,record.classification??'unclassified',stats.count,unreadCount,JSON.stringify(record));
   for(const tag of new Set(record.tags??[]))this.sql.exec('INSERT OR IGNORE INTO incoming_tags(owner,tag,item_id) VALUES(?,?,?)',owner,tag,id);
  }
  this.setIncomingState('revision',Number(this.incomingState('revision'))+1);
 }
 incomingPreferences(owner,id,fallback){
  const existing=[...this.sql.exec('SELECT generation,revision,record FROM incoming_preferences WHERE owner=? AND id=?',owner,id)][0];if(existing)return {...existing,record:migrateTags(JSON.parse(existing.record))};
  const previous=[...this.sql.exec('SELECT record FROM incoming_catalog WHERE owner=? AND id=?',owner,id)][0],source=previous?JSON.parse(previous.record):fallback,record=migrateTags({tags:[...source.tags??[]],classification:source.classification??'unclassified'});
  this.sql.exec('INSERT INTO incoming_preferences(owner,id,generation,revision,record) VALUES(?,?,0,1,?)',owner,id,JSON.stringify(record));return {generation:0,revision:1,record};
 }
 updateIncoming(owner,input,now=Date.now()){
  const request=normalizeIncomingUpdate(input),row=[...this.sql.exec('SELECT record FROM incoming_catalog WHERE owner=? AND id=?',owner,request.id)][0];
  if(!row)throw new StorageError('not_found','This conversation has no retained incoming items.',404);
  const current=JSON.parse(row.record),prefs=this.incomingPreferences(owner,request.id,current);if(prefs.revision!==request.expectedRevision)throw new StorageError('item_conflict','Conversation organization changed. Refresh before saving.',409);
  if(request.read===true&&request.expectedActivityRevision!==prefs.generation)throw new StorageError('item_conflict','New conversation activity arrived. Refresh before marking read.',409);
  try{const {tags,addTags,removeTags,classification}=request;changeTags(prefs.record,{tags,addTags,removeTags,classification},{source:'owner'},now,{owner:true});}catch(e){if(e.code!=='invalid_actions')throw e;throw new StorageError('invalid_view','Choose valid conversation tags.');}
  if(request.read!==undefined){prefs.record.readMode=request.read?'through':'unread';if(request.read){prefs.record.readThrough=prefs.generation;prefs.record.readAt=now;}}
  this.sql.exec('UPDATE incoming_preferences SET revision=?,record=? WHERE owner=? AND id=?',prefs.revision+1,JSON.stringify(prefs.record),owner,request.id);this.refreshIncoming(owner,request.id);
  return JSON.parse([...this.sql.exec('SELECT record FROM incoming_catalog WHERE owner=? AND id=?',owner,request.id)][0].record);
 }
 async incomingPage(owner,{filter,sort,limit=50,cursor,view,viewRevision}={}){
  filter=normalizeIncomingFilter(filter);sort=incomingSort(sort);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new StorageError('invalid_args','Choose a page size from 1 to 100.');
  const scope=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([owner,filter,sort,view??null,viewRevision??null]))))].map(v=>v.toString(16).padStart(2,'0')).join(''),key=await crypto.subtle.importKey('raw',Uint8Array.from(decode(this.incomingState('cursor-key'))),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  let boundary;
  if(cursor){try{if(typeof cursor!=='string'||cursor.length>8192)throw Error();const parts=cursor.split('.');if(parts.length!==2)throw Error();const signature=Uint8Array.from(atob(parts[1].replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));if(!await crypto.subtle.verify('HMAC',key,signature,new TextEncoder().encode(parts[0])))throw Error();boundary=decode(parts[0]);if(boundary.scope!==scope||!Number.isSafeInteger(boundary.at)||typeof boundary.id!=='string'||boundary.id.length>1024||!Number.isSafeInteger(boundary.revision))throw Error();}catch{throw new StorageError('invalid_cursor','This cursor does not match the requested View.');}}
  const revision=Number(this.incomingState('revision'));if(boundary&&boundary.revision!==revision)throw new StorageError('cursor_stale','Incoming items changed. Refresh this View.',409);
  const column=sort==='received-desc'?'received_at':'activity_at',where=['c.owner=?'],args=[owner];
  if(filter.read!==undefined){where.push('c.unread=?');args.push(filter.read?0:1);}
  for(const [field,col]of [['types','type'],['classifications','classification']])if(filter[field]){where.push(`c.${col} IN (${filter[field].map(()=>'?').join(',')})`);args.push(...filter[field]);}
  for(const tag of filter.tagsAll??[]){where.push('EXISTS (SELECT 1 FROM incoming_tags t WHERE t.owner=c.owner AND t.item_id=c.id AND t.tag=?)');args.push(tag);}
  if(filter.receivedAfter!==undefined){where.push('c.received_at>=?');args.push(filter.receivedAfter);}
  if(filter.receivedBefore!==undefined){where.push('c.received_at<?');args.push(filter.receivedBefore);}
  if(boundary){where.push(`(c.${column}<? OR (c.${column}=? AND c.id<?))`);args.push(boundary.at,boundary.at,boundary.id);}
  const rows=[...this.sql.exec(`SELECT c.id,c.${column} AS at,c.record FROM incoming_catalog c WHERE ${where.join(' AND ')} ORDER BY c.${column} DESC,c.id DESC LIMIT ?`,...args,limit+1)],shown=rows.slice(0,limit),last=shown.at(-1);let next=null;
  if(rows.length>limit){const payload=encode({scope,revision,at:last.at,id:last.id}),signature=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(payload)));next=payload+'.'+btoa(String.fromCharCode(...signature)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
  return {items:shown.map(row=>JSON.parse(row.record)),cursor:next,indexRevision:revision};
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

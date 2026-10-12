import {StorageError,objectKey,checkedFetch,jsonBody,boundedBody,rangeHeaders} from './policy.mjs';
import {encryptSecret,decryptSecret} from '../runtime/secrets.mjs';
import {encode} from '../identity/crypto.mjs';
const SCOPE='https://www.googleapis.com/auth/drive.file',CONTRACT='https://3sln.me/artefacts/contracts/object-storage/v1';
const utf8=new TextEncoder(),random=()=>encode(crypto.getRandomValues(new Uint8Array(32)));
const digest=async bytes=>encode(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
const hash=async s=>digest(utf8.encode(s));
const fail=(code,message,status=400)=>{throw new StorageError(code,message,status);};
const clean=r=>{const {secret,...publicValue}=r;return publicValue;};
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(id);
// All provider mutation targets are immutable. Conditional publication is the
// account metadata transaction, never an undocumented Drive HTTP precondition.
export class GoogleDriveService {
 constructor({metadata,config,fetcher=fetch,clock=Date.now}){Object.assign(this,{metadata,config,fetcher,clock});}
 configured(){return Boolean(this.config.GOOGLE_CLIENT_ID&&this.config.GOOGLE_CLIENT_SECRET&&this.config.KEY_ENCRYPTION_KEY&&this.config.APP_ORIGIN);}
 callback(){return new URL('/api/integrations/google/callback',this.config.APP_ORIGIN).href;}
 async seal(value){return encryptSecret(value,this.config.KEY_ENCRYPTION_KEY);}
 async open(value){return decryptSecret(value,this.config.KEY_ENCRYPTION_KEY);}
 async begin(owner,sessionId,name='Google Drive',{resourceId}={}){
  if(!this.configured())fail('integration_unconfigured','Google Drive is not configured.',503);
  if(typeof sessionId!=='string'||!sessionId||typeof name!=='string'||!name.trim()||name.length>100)fail('invalid_request','A current session and resource name are required.');
  const state=random(),verifier=random(),expiresAt=this.clock()+600000;
  let reconnect;
  if(resourceId){const {resource,secret}=await this.binding(owner,resourceId);if(!validId(secret.permissionId))fail('reconnect_unavailable','This older connection cannot safely be reconnected.',409);reconnect={resourceId,generation:resource.generation,rootFolder:secret.rootFolder,permissionId:secret.permissionId};name=resource.name;}
  const pending={owner,session:await hash(sessionId),stateHash:await hash(state),expiresAt,name:name.trim(),verifier,...reconnect?{reconnect}:{}};
  await this.metadata.put('drive/oauth/'+await hash(sessionId),await this.seal(pending));
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [k,v] of Object.entries({client_id:this.config.GOOGLE_CLIENT_ID,redirect_uri:this.callback(),response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:await hash(verifier),code_challenge_method:'S256'}))url.searchParams.set(k,v);
  return {url:url.href,expiresAt};
 }
 async token(params){
  const response=await checkedFetch(this.fetcher,'https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,client_id:this.config.GOOGLE_CLIENT_ID,client_secret:this.config.GOOGLE_CLIENT_SECRET})});
  const value=await jsonBody(response);
  if(typeof value.access_token!=='string'||!value.access_token||typeof value.token_type!=='string'||value.token_type.toLowerCase()!=='bearer'||!Number.isFinite(value.expires_in)||value.expires_in<60||value.expires_in>86400)fail('invalid_response','Google returned an invalid token response.',502);
  if(value.scope!==undefined&&!(typeof value.scope==='string'&&value.scope.split(' ').every(s=>s===SCOPE)&&value.scope.split(' ').includes(SCOPE)))fail('scope_denied','Google Drive access was not granted.',403);
  if(value.refresh_token!==undefined&&(typeof value.refresh_token!=='string'||!value.refresh_token))fail('invalid_response','Google returned an invalid refresh token.',502);
  if(params.grant_type==='authorization_code'&&value.scope!==SCOPE)fail('scope_denied','Google Drive access was not granted.',403);
  return {...value,expiresAt:this.clock()+value.expires_in*1000};
 }
 async complete(owner,sessionId,{state,code,error}={}){
  const path='drive/oauth/'+await hash(sessionId),stateHash=typeof state==='string'&&state.length<=200?await hash(state):null;
  const pending=await this.metadata.transaction(async tx=>{const sealed=await tx.get(path);if(!sealed)fail('oauth_expired','The connection request expired. Start again.',409);const p=await this.open(sealed);if(p.owner!==owner||p.session!==await hash(sessionId)||p.stateHash!==stateHash||p.expiresAt<=this.clock())fail('oauth_state','The connection request does not match this session.',403);await tx.delete(path);return p;});
  if(error)fail('oauth_denied','Google Drive connection was declined.',400);
  if(typeof code!=='string'||!code||code.length>4096)fail('invalid_request','The authorization code is missing.');
  const tokens=await this.token({grant_type:'authorization_code',code,code_verifier:pending.verifier,redirect_uri:this.callback()});
  if(typeof tokens.refresh_token!=='string'||!tokens.refresh_token)fail('offline_access_required','Google did not grant offline access. Reconnect and approve access.',409);
  const about=await jsonBody(await checkedFetch(this.fetcher,'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)',{headers:{Authorization:'Bearer '+tokens.access_token}}));
  const permissionId=about.user?.permissionId;if(!validId(permissionId))fail('invalid_response','Google did not identify the Drive account.',502);
  if(pending.reconnect)return this.completeReconnect(owner,pending.reconnect,tokens,permissionId);
  const resourceId=crypto.randomUUID(),generation=crypto.randomUUID();
  const generated=await jsonBody(await checkedFetch(this.fetcher,'https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files',{headers:{Authorization:'Bearer '+tokens.access_token}}));
  if(!Array.isArray(generated.ids)||generated.ids.length!==1||!validId(generated.ids[0]))fail('invalid_response','Google returned an invalid folder identifier.',502);
  const folderId=generated.ids[0],folderJournal='drive/folder-pending/'+resourceId;
  await this.metadata.transaction(async tx=>{if(typeof tx.list==='function'&&(await tx.list({prefix:'drive/folder-pending/',limit:101})).size>=100)fail('connection_pending_limit','Too many unfinished Drive connections.',409);await tx.put(folderJournal,await this.seal({owner,resourceId,generation,folderId,tokens,createdAt:this.clock()}));});
  const root=await jsonBody(await checkedFetch(this.fetcher,'https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json'},body:JSON.stringify({id:folderId,name:pending.name+' · Bindle',mimeType:'application/vnd.google-apps.folder',appProperties:{bindleResource:resourceId}})}));
  if(root.id!==folderId)fail('invalid_response','Google returned an unexpected folder identifier.',502);
  const resource={id:resourceId,owner,name:pending.name,provider:'google-drive',status:'connected',contracts:[CONTRACT],generation,verifiedAt:this.clock(),capabilities:this.capabilities(),secret:await this.seal({owner,resourceId,generation,rootFolder:root.id,permissionId,accessToken:tokens.access_token,refreshToken:tokens.refresh_token,expiresAt:tokens.expiresAt})};
  await this.metadata.transaction(async tx=>{if(typeof tx.list==='function'&&(await tx.list({prefix:'resource/',limit:101})).size>=100)fail('resource_limit','Remove an unused resource before connecting another.',409);await tx.put('resource/'+resourceId,resource);await tx.delete(folderJournal);});return clean(resource);
 }
 capabilities(){return {read:true,write:true,delete:true,range:true,conditionalWrites:true,presigned:{read:false,write:false},maxObjectBytes:1048576,namespace:'provider-managed-logical-keys',conditionalAuthority:'bindle-host',physicalRetention:true,maxObjects:10000,retainedVersionLimit:10000,nativeDocuments:false};}
 async binding(owner,id){const resource=await this.metadata.get('resource/'+id);if(resource?.owner!==owner||resource.provider!=='google-drive'||!['connected','reauthorization_required'].includes(resource.status))fail('forbidden','Google Drive connection is unavailable.',403);const secret=await this.open(resource.secret);if(secret.owner!==owner||secret.resourceId!==id||secret.generation!==resource.generation||!validId(secret.rootFolder))fail('forbidden','Google Drive credential binding is invalid.',403);return {resource,secret};}
 async load(owner,id){const bound=await this.binding(owner,id);if(bound.resource.status!=='connected')fail('reauthorization_required','Reconnect Google Drive to continue.',409);return bound;}
 async completeReconnect(owner,reconnect,tokens,permissionId){
  const {resource,secret}=await this.binding(owner,reconnect.resourceId);
  if(resource.generation!==reconnect.generation||secret.rootFolder!==reconnect.rootFolder||secret.permissionId!==reconnect.permissionId)fail('reconnect_conflict','The Drive connection changed. Start again.',409);
  if(permissionId!==reconnect.permissionId)fail('google_account_mismatch','Choose the same Google account to reconnect this resource.',409);
  const root=await jsonBody(await checkedFetch(this.fetcher,`https://www.googleapis.com/drive/v3/files/${secret.rootFolder}?fields=id,mimeType,trashed,appProperties,owners(permissionId),capabilities(canAddChildren)`,{headers:{Authorization:'Bearer '+tokens.access_token}}));
  if(root.id!==secret.rootFolder||root.trashed||root.mimeType!=='application/vnd.google-apps.folder'||root.appProperties?.bindleResource!==resource.id||!root.owners?.some(o=>o.permissionId===permissionId)||root.capabilities?.canAddChildren!==true)fail('root_changed','The original managed Drive folder is unavailable or changed.',409);
  const generation=crypto.randomUUID(),replacement={...resource,generation,status:'connected',verifiedAt:this.clock(),secret:await this.seal({...secret,generation,accessToken:tokens.access_token,refreshToken:tokens.refresh_token,expiresAt:tokens.expiresAt})};
  await this.metadata.transaction(async tx=>{const current=await tx.get('resource/'+resource.id);if(current?.owner!==owner||current.provider!=='google-drive'||current.generation!==reconnect.generation||!['connected','reauthorization_required'].includes(current.status))fail('reconnect_conflict','The Drive connection changed. Start again.',409);await tx.put('resource/'+resource.id,replacement);});return {...clean(replacement),reconnected:true};
 }
 async access(owner,id){let {resource,secret}=await this.load(owner,id);if(secret.expiresAt>this.clock()+60000)return {resource,secret};let tokens;try{tokens=await this.token({grant_type:'refresh_token',refresh_token:secret.refreshToken});}catch(error){if([400,401].includes(error.status)){await this.metadata.transaction(async tx=>{const current=await tx.get('resource/'+id);if(current?.status==='connected'&&current.generation===resource.generation&&JSON.stringify(current.secret)===JSON.stringify(resource.secret))await tx.put('resource/'+id,{...current,status:'reauthorization_required'});});}throw error;}
  secret={...secret,accessToken:tokens.access_token,refreshToken:tokens.refresh_token||secret.refreshToken,expiresAt:tokens.expiresAt};
  await this.metadata.transaction(async tx=>{const current=await tx.get('resource/'+id);if(current?.status!=='connected'||current.generation!==resource.generation)fail('forbidden','Google Drive connection was removed.',403);if(JSON.stringify(current.secret)!==JSON.stringify(resource.secret))fail('refresh_conflict','The connection was refreshed concurrently. Retry the operation.',409);await tx.put('resource/'+id,{...current,secret:await this.seal(secret)});});return {resource,secret};
 }
 async adapter(owner,id){await this.load(owner,id);return {describe:()=>this.capabilities(),get:args=>this.get(owner,id,args),put:args=>this.put(owner,id,args),delete:args=>this.delete(owner,id,args)};}
 async path(id,key){return 'drive/object/'+id+'/'+await hash(objectKey(key));}
 async get(owner,id,{key,range,ifVersion}){
  await this.load(owner,id);
  const path=await this.path(id,key),entry=await this.metadata.get(path);if(!entry||entry.key!==key)fail('not_found','Object not found.',404);if(!validId(entry.fileId)||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>1048576||typeof entry.digest!=='string')fail('invalid_record','Managed Drive object metadata is invalid.',502);if(ifVersion&&ifVersion!==entry.version)fail('conflict','Object version changed.',409);
  const {secret,resource}=await this.access(owner,id),headers={Authorization:'Bearer '+secret.accessToken};
  const info=await jsonBody(await checkedFetch(this.fetcher,`https://www.googleapis.com/drive/v3/files/${entry.fileId}?fields=id,parents,mimeType,trashed,size,version`,{headers}));
  if(info.id!==entry.fileId||typeof info.version!=='string'||!/^\d+$/.test(info.version)||info.trashed||!info.parents?.includes(secret.rootFolder)||info.mimeType?.startsWith('application/vnd.google-apps.')||Number(info.size)!==entry.size)fail('object_changed','The managed Drive object was changed outside Bindle.',409);
  const response=await checkedFetch(this.fetcher,`https://www.googleapis.com/drive/v3/files/${entry.fileId}?alt=media`,{headers});
  let bytes=await boundedBody(response);if(bytes.length!==entry.size||await digest(bytes)!==entry.digest)fail('object_changed','The managed Drive object was changed outside Bindle.',409);
  const after=await jsonBody(await checkedFetch(this.fetcher,`https://www.googleapis.com/drive/v3/files/${entry.fileId}?fields=id,parents,mimeType,trashed,size,version`,{headers}));
  if(after.id!==entry.fileId||after.trashed||!after.parents?.includes(secret.rootFolder)||after.version!==info.version||Number(after.size)!==entry.size||after.mimeType!==info.mimeType)fail('object_changed','The managed Drive object changed while reading.',409);
  const current=await this.load(owner,id);if(current.resource.generation!==resource.generation)fail('forbidden','Google Drive connection was removed.',403);
  if(range){rangeHeaders(range);if(range.start>=bytes.length||range.end>=bytes.length)fail('invalid_range','The range exceeds the object.');bytes=bytes.slice(range.start,range.end+1);}
  return {bytes,version:entry.version,contentType:entry.contentType,size:entry.size};
 }
 async put(owner,id,{key,bytes,condition,contentType='application/octet-stream'}){
  await this.load(owner,id);
  const path=await this.path(id,key);if(!(bytes instanceof Uint8Array)||bytes.length>1048576||typeof contentType!=='string'||contentType.length>200||!/^[-\w.+]+\/[-\w.+]+(?:;[^\r\n]*)?$/.test(contentType)||contentType.startsWith('application/vnd.google-apps.'))fail('invalid_request','Object data or content type is invalid.');
  if(!condition||Object.keys(condition).length!==1||!(condition.absent===true||typeof condition.version==='string'&&condition.version))fail('condition_required','An exact write condition is required.');
  const matches=e=>condition.absent===true?!e:e?.version===condition.version;
  const existing=await this.metadata.get(path);if(!matches(existing))fail('conflict','Object version changed.',409);

  const usage=await this.metadata.get('drive/usage/'+id)||{objects:0,retained:0};if(!existing&&usage.objects>=10000||existing&&usage.retained>=10000)fail('object_limit','This Drive resource has reached its managed object or retained version limit.',409);
  const {resource,secret}=await this.access(owner,id),boundary='bindle_'+random(),version=crypto.randomUUID();
  const ids=await jsonBody(await checkedFetch(this.fetcher,'https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files',{headers:{Authorization:'Bearer '+secret.accessToken}}));
  if(!Array.isArray(ids.ids)||ids.ids.length!==1||!validId(ids.ids[0]))fail('invalid_response','Google returned an invalid generated identifier.',502);
  const fileId=ids.ids[0],journal='drive/pending/'+id+'/'+fileId,contentDigest=await digest(bytes);
  await this.metadata.transaction(async tx=>{if(typeof tx.list==='function'&&(await tx.list({prefix:'drive/pending/',limit:101})).size>=100)fail('upload_pending_limit','Too many unfinished Drive uploads. Contact the host administrator.',409);await tx.put(journal,{owner,resourceId:id,generation:resource.generation,fileId,key,version,size:bytes.length,contentType,digest:contentDigest,createdAt:this.clock()});});
  const metadata={id:fileId,name:'bindle-'+version,parents:[secret.rootFolder],appProperties:{bindleResource:id,bindleKey:await hash(key)},mimeType:contentType};
  const before=utf8.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),after=utf8.encode(`\r\n--${boundary}--\r\n`),body=new Uint8Array(before.length+bytes.length+after.length);body.set(before);body.set(bytes,before.length);body.set(after,before.length+bytes.length);
  const created=await jsonBody(await checkedFetch(this.fetcher,'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{Authorization:'Bearer '+secret.accessToken,'Content-Type':'multipart/related; boundary='+boundary},body}));if(created.id!==fileId)fail('invalid_response','Google returned an unexpected file identifier.',502);
  let previous;try{await this.metadata.transaction(async tx=>{const current=await tx.get('resource/'+id);previous=await tx.get(path);if(current?.status!=='connected'||current.generation!==resource.generation)fail('forbidden','Google Drive connection was removed.',403);if(!matches(previous))fail('conflict','Object version changed.',409);const usage=await tx.get('drive/usage/'+id)||{objects:0,retained:0};if(!previous&&usage.objects>=10000||previous&&usage.retained>=10000)fail('object_limit','This Drive resource has reached its managed object or retained version limit.',409);await tx.put('drive/usage/'+id,{objects:usage.objects+(previous?0:1),retained:usage.retained+(previous?1:0)});await tx.put(path,{key,fileId:created.id,version,size:bytes.length,contentType,digest:contentDigest});await tx.delete(journal);if(previous)await tx.put('drive/retained/'+id+'/'+previous.fileId,{...previous,reason:'superseded',createdAt:this.clock()});});}catch(error){throw error;}
  // Never physically delete immutable blobs: a prior read may still reference
  // them and Drive cannot atomically exclude external edits/moves on deletion.
  return {version,size:bytes.length,contentType};
 }
 async removeFile(secret,fileId){await checkedFetch(this.fetcher,'https://www.googleapis.com/drive/v3/files/'+fileId,{method:'DELETE',headers:{Authorization:'Bearer '+secret.accessToken}});}
 async delete(owner,id,{key,version}){const path=await this.path(id,key);if(typeof version!=='string'||!version)fail('condition_required','An exact delete version is required.');const {resource,secret}=await this.access(owner,id);const entry=await this.metadata.transaction(async tx=>{const current=await tx.get('resource/'+id),entry=await tx.get(path);if(current?.generation!==resource.generation||current.status!=='connected')fail('forbidden','Google Drive connection was removed.',403);if(entry?.version!==version)fail('conflict','Object version changed.',409);const usage=await tx.get('drive/usage/'+id)||{objects:1,retained:0};if(usage.retained>=10000)fail('retention_limit','This Drive resource has reached its retained version limit.',409);await tx.put('drive/usage/'+id,{objects:Math.max(0,usage.objects-1),retained:usage.retained+1});await tx.delete(path);await tx.put('drive/retained/'+id+'/'+entry.fileId,{...entry,reason:'deleted',createdAt:this.clock()});return entry;});return {deleted:true,physicalRetention:true};}
 async disconnect(owner,id){
  const resource=await this.metadata.get('resource/'+id);if(resource?.owner!==owner||resource.provider!=='google-drive')fail('forbidden','Google Drive connection is unavailable.',403);
  const secret=await this.open(resource.secret);if(secret.owner!==owner||secret.resourceId!==id||secret.generation!==resource.generation)fail('forbidden','Google Drive credential binding is invalid.',403);
  // Google revocation invalidates the principal's project-wide authorization,
  // including other OAuth clients. Removing one resource must stay local.
  await this.metadata.transaction(async tx=>{const current=await tx.get('resource/'+id);if(current?.owner!==owner||current.provider!=='google-drive'||current.generation!==resource.generation||JSON.stringify(current.secret)!==JSON.stringify(resource.secret))fail('connection_conflict','The Drive connection changed. Try disconnecting again.',409);await tx.delete('resource/'+id);});
  return {deleted:true,providerRevoked:false,localOnly:true};
 }
}

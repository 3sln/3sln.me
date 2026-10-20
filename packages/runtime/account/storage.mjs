// AccountController slice 6, Storage, quota, resources and Google Drive (docs/architecture/app-engine.md §12): built-in storage, resources, hosted objects and the resource RPC.
// `methods` are installed on AccountController.prototype (`this` is the controller); `rpc` lists the methods
// `invoke` accepts and the placement policy it applies to each (packages/runtime/account/index.mjs).
import {APP_NOTIFICATIONS} from '../../federation/app-notifications.mjs';
import {createAppNotification} from '../app-notifications.mjs';
import {RESOURCE_SCOPING,storageScopeOptions} from '../../storage/scoping.mjs';
import {retryReady,retryFailure} from '../cleanup-retry.mjs';
import {key,canonical} from '../../messaging/store.mjs';
import {encryptSecret,decryptSecret} from '../secrets.mjs';
import {S3Adapter,WebDAVAdapter} from '../../storage/adapters.mjs';
import {objectKey,StorageError} from '../../storage/policy.mjs';
import {UUID_V4} from '../../core/primitives.mjs';
import {archiveDigest} from './support.mjs';

export const methods={
  async ensureBuiltinStorage(owner){
    const pointerKey='builtin/hosted-resource-v1',contract='https://3sln.me/artefacts/contracts/object-storage/v1',uuid=UUID_V4;
    const unavailable=()=>{throw new StorageError('storage_unavailable','The built-in storage binding needs repair.',503);};
    const valid=resource=>resource&&uuid.test(resource.id)&&resource.owner===owner&&resource.provider==='hosted'&&resource.builtin===true&&resource.status==='connected'&&resource.kind===undefined&&!Object.hasOwn(resource,'secret')&&resource.contracts?.includes(contract)&&resource.capabilities?.read===true&&resource.capabilities?.write===true;
    return this.metadata.transaction(async tx=>{
      const boundOwner=await tx.get('owner');if(boundOwner!==undefined&&boundOwner!==owner)throw new StorageError('forbidden','Account owner mismatch.',403);
      const existingBuiltins=async()=>{
        const rows=await tx.list({prefix:'resource/',limit:201});if(rows.size>200||[...rows.values()].some(resource=>resource.owner!==owner))unavailable();
        const entries=[...rows].filter(([,resource])=>resource.builtin===true);
        if(entries.length>1||entries.some(([key,resource])=>!valid(resource)||key!==`resource/${resource.id}`))unavailable();return entries.map(([,resource])=>resource);
      };
      const pointer=await tx.get(pointerKey);let id,resource;
      if(pointer!==undefined){
        if(pointer?.version!==1||pointer.owner!==owner||typeof pointer.id!=='string'||!uuid.test(pointer.id))unavailable();id=pointer.id;resource=await tx.get(`resource/${id}`);
        if(resource&&(!valid(resource)||resource.id!==id))unavailable();
        if(!resource){const existing=await existingBuiltins();if(existing.length&&existing[0].id!==id)unavailable();}
      }else {const existing=await existingBuiltins();resource=existing[0];id=resource?.id??crypto.randomUUID();}
      const freshBuiltin=!resource&&pointer===undefined;
      if(!resource){resource={id,owner,name:'Account storage',provider:'hosted',builtin:true,status:'connected',contracts:[contract],capabilities:{read:true,write:true,range:true,conditionalWrites:true,presigned:{read:false,write:false},maxObjectBytes:1048576},verifiedAt:Date.now()};await tx.put(`resource/${id}`,resource);}
      if(pointer===undefined)await tx.put(pointerKey,{version:1,owner,id});if(boundOwner===undefined)await tx.put('owner',owner);return resource;
    });
  },
  async storageUsage(owner){await this.warm(owner);const usage=await this.quota.usage(owner);return {...usage,...this.storageWriteBudget?{writeOperations:await this.storageWriteBudget.status(owner)}:{}};},
  async resources(owner){const rows=await this.metadata.list({prefix:'resource/'});return [...rows.values()].filter(r=>r.kind!=='app-connection').map(({secret,...resource})=>{const {list:legacyList,...capabilities}=resource.capabilities||{};return {...resource,capabilities};});},
  async addResource(owner,input){
    if((await this.resources(owner)).length>=100)throw Object.assign(new Error('This account has reached its resource limit.'),{code:'resource_limit',status:429});
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new Error('Resource name required');
    if(input.provider==='hosted'){const resource={id:crypto.randomUUID(),owner,name:input.name.trim(),provider:'hosted',status:'connected',contracts:['https://3sln.me/artefacts/contracts/object-storage/v1'],capabilities:{read:true,write:true,range:true,conditionalWrites:true,presigned:{read:false,write:false},maxObjectBytes:1048576},verifiedAt:Date.now()};await this.metadata.put(`resource/${resource.id}`,resource);return resource;}
    if(!['s3','webdav'].includes(input.provider))throw new Error('Provider requires OAuth configuration');
    const config=input.config||input;const options={allowedHosts:(this.config.ALLOWED_CONNECTOR_HOSTS||'').split(',').filter(Boolean)};
    const adapter=input.provider==='s3'?new S3Adapter({...config,write:false,conditionalWrites:false},options):new WebDAVAdapter(config,options);
    const resource={id:crypto.randomUUID(),owner,name:input.name.trim(),provider:input.provider,status:'unverified',contracts:['https://3sln.me/artefacts/contracts/object-storage/v1'],capabilities:adapter.describe(),secret:await encryptSecret({...config,write:false,conditionalWrites:false},this.config.KEY_ENCRYPTION_KEY)};
    await this.metadata.put(`resource/${resource.id}`,resource);const {secret,...publicResource}=resource;return publicResource;
  },
  async googleDriveStart(owner,sessionId,input){await this.warm(owner);if(!input?.resourceId&&(await this.resources(owner)).length>=100)throw new StorageError('resource_limit','This account has reached its resource limit.',429);if(!input||Object.keys(input).some(k=>!['name','resourceId'].includes(k)))throw new StorageError('invalid_args','Choose a connection name.');await this.admitWork(owner);const result=await this.googleDrive.begin(owner,sessionId,input.name,{resourceId:input.resourceId});await this.touch(owner);return {authorizationUrl:result.url,expiresAt:result.expiresAt};},
  async googleDriveComplete(owner,sessionId,input){await this.warm(owner);if(!input||Object.keys(input).some(k=>!['state','code','error'].includes(k)))throw new StorageError('invalid_args','Invalid Google connection callback.');await this.admitWork(owner);const result=await this.googleDrive.complete(owner,sessionId,input);await this.touch(owner);return result;},
  async verifyResource(owner,id,input={}){objectKey(input.key);const resource=await this.metadata.get(`resource/${id}`);if(!resource||resource.owner!==owner||resource.kind==='app-connection')throw new Error('Resource not found');const options={allowedHosts:(this.config.ALLOWED_CONNECTOR_HOSTS||'').split(',').filter(Boolean)};const config=resource.provider==='google-drive'?null:await decryptSecret(resource.secret,this.config.KEY_ENCRYPTION_KEY);const adapter=resource.provider==='google-drive'?await this.googleDrive.adapter(owner,id):resource.provider==='s3'?new S3Adapter(config,options):new WebDAVAdapter(config,options);await adapter.get({key:input.key});const updated=await this.metadata.transaction(async tx=>{const current=await tx.get(`resource/${id}`);if(!current||current.owner!==owner||current.generation!==resource.generation)throw new StorageError('forbidden','The connection changed during verification.',403);const next={...current,capabilities:adapter.describe(),status:'connected',verifiedAt:Date.now()};await tx.put(`resource/${id}`,next);return next;});const {secret,...result}=updated;return result;},
  async deleteResource(owner,id){const builtin=await this.metadata.get('builtin/hosted-resource-v1');if(builtin?.owner===owner&&builtin.id===id)throw new StorageError('builtin_resource','Account storage is always available and cannot be disconnected.',409);const app=await this.metadata.get(`resource/${id}`);if(app?.kind==='app-connection')return this.apps.disconnect(owner,id);const resource=await this.metadata.get(`resource/${id}`);if(!resource||resource.owner!==owner)throw new Error('Resource not found');if(resource.builtin===true)throw new StorageError('builtin_resource','Account storage is always available and cannot be disconnected.',409);if(resource.provider==='google-drive')return this.googleDrive.disconnect(owner,id);if(resource.provider==='hosted'&&(await this.metadata.list({prefix:`hosted/${id}/`,limit:1})).size)throw new StorageError('resource_not_empty','Delete the files in this hosted resource before removing it.',409);await this.metadata.delete(`resource/${id}`);return {deleted:true};},
  async federationRPC(context){
    const owner=/\/entities\/([a-f0-9-]{36})$/.exec(context.subject)?.[1];if(!owner||context.subject!==`${this.config.APP_ORIGIN}/entities/${owner}`)throw new StorageError('forbidden','Resource access denied.',403);
    if(context.contract===APP_NOTIFICATIONS)return createAppNotification(this,owner,context);
    if(context.method==='list')throw new StorageError('unsupported_method','Object storage has no listing operation; use application-managed directory objects.');
    await this.warm(owner);
    if(context.authority==='bindle'&&(!context.epoch||!context.connection||!this.config.FEDERATION_IDENTITY_CHECK||await this.config.FEDERATION_IDENTITY_CHECK(owner,context.epoch)!==true))throw new StorageError('unauthorized','Application authorization is no longer active.',401);
    if(context.connection)await this.apps.check(owner,context.connection.id,context.connection.generation,context.clientId);
    const resourceId=new RegExp(`^${escapeRegex(this.config.APP_ORIGIN)}/entities/${owner}/resources/([a-f0-9-]{36})$`).exec(context.resource)?.[1];
    const resource=resourceId&&await this.metadata.get(`resource/${resourceId}`);
    if(!resource||resource.owner!==owner||resource.kind==='app-connection'||resource.status!=='connected'||!['https://3sln.me/artefacts/contracts/object-storage/v1',RESOURCE_SCOPING].includes(context.contract))throw new StorageError('forbidden','Resource access denied.',403);
    if(context.resourceGeneration!==undefined&&context.resourceGeneration!==String(resource.generation??resource.id))throw new StorageError('forbidden','The resource connection changed. Review access again.',403);
    if(context.contract===RESOURCE_SCOPING){if(context.method!=='describe'||Object.keys(context.args).length)throw new StorageError('unsupported_method','Scoping options use describe with no arguments.');return storageScopeOptions(resource.capabilities);}
    const assignedScope=context.scope??{};
    if(assignedScope.prefix&&context.args.key!==undefined){const prefix=assignedScope.prefix.replace(/\/$/,'');if(typeof context.args.key!=='string'||context.args.key!==prefix&&!context.args.key.startsWith(prefix+'/'))throw new StorageError('forbidden','The object is outside the assigned scope.',403);}
    if(assignedScope.readOnly&&(['put','delete'].includes(context.method)||context.method==='presign'&&context.args.operation==='write'))throw new StorageError('forbidden','This assignment is read only.',403);
    if(assignedScope.maxObjectBytes&&context.method==='presign')throw new StorageError('unsupported_method','Presigned URLs cannot enforce this assignment byte limit.');
    if(assignedScope.prefix&&context.method==='presign')throw new StorageError('unsupported_method','Presigned URLs cannot conceal this assignment namespace.');
    if(assignedScope.maxObjectBytes&&context.args.range&&resource.provider!=='hosted')throw new StorageError('unsupported_method','This connector cannot verify the full object size for a bounded range read.');
    if(assignedScope.maxObjectBytes&&context.method==='put'&&typeof context.args.dataBase64==='string'&&Math.floor(context.args.dataBase64.length*3/4)-(context.args.dataBase64.endsWith('==')?2:context.args.dataBase64.endsWith('=')?1:0)>assignedScope.maxObjectBytes)throw new StorageError('forbidden','The object exceeds the assigned byte limit.',403);
    if(!/^[a-f0-9-]{36}$/.test(context.tx)||typeof context.clientId!=='string')throw new StorageError('invalid_args','A transaction UUID is required.');
    const fingerprint=await archiveDigest(canonical({resource:context.resource,contract:context.contract,method:context.method,args:context.args,...context.authority==='bindle'?{addressedResource:context.addressedResource,epoch:context.epoch,resourceGeneration:context.resourceGeneration,scope:assignedScope,connection:context.connection}: {}}));
    const journalKey=`rpc-journal/${encodeURIComponent(context.clientId)}/${context.tx}`;let prior=await this.metadata.get(journalKey);if(prior&&prior.createdAt+86400000<=Date.now()){await this.metadata.delete(journalKey);prior=null;}
    if(prior){if(prior.fingerprint!==fingerprint)throw new StorageError('tx_conflict','Transaction identifier was reused with different arguments.',409);if(prior.state!=='done')throw new StorageError('indeterminate','The earlier operation must be reconciled before retrying.',503);if(prior.error)throw Object.assign(new StorageError(prior.error.code,prior.error.message,prior.error.status),prior.error.retryAfter?{retryAfter:prior.error.retryAfter}:{});if(prior.resultRef){const blob=await this.blobs.get(prior.resultRef);if(!blob)throw new StorageError('temporarily_unavailable','Stored outcome is temporarily unavailable.',503);return blob.json();}return prior.result;}
    const mutating=['put','delete'].includes(context.method);
    // A durable reservation precedes effects. Recovery never repeats a write
    // whose effect may have happened before the completed journal was stored.
    let journalReserved=false;const reserveJournal=async()=>{let live=0;for(const [record,value]of await this.metadata.list({prefix:'rpc-journal/',limit:257})){if(value.createdAt+86400000<=Date.now())await this.metadata.delete(record);else live++;}if(live>=256)throw new StorageError('rate_limited','This account has reached its retained write-operation limit.',429);await this.metadata.put(journalKey,{fingerprint,state:'reserved',createdAt:Date.now()});journalReserved=true;};
    try{
      let result;
      if(resource.provider==='hosted')result=await this.hostedOperation(resource,context.method,context.args,reserveJournal,context.clientId);
      else if(resource.provider==='google-drive'){const adapter=await this.googleDrive.adapter(owner,resource.id);if(context.method==='capabilities')result=adapter.describe();else if(context.method==='get'){const value=await adapter.get(context.args);result={dataBase64:base64(value.bytes),object:{key:context.args.key,version:value.version,size:value.size??value.bytes.byteLength,contentType:value.contentType}};}else if(context.method==='put'){if(typeof context.args.dataBase64!=='string'||context.args.dataBase64.length>1398104||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(context.args.dataBase64))throw new StorageError('invalid_args','Canonical base64 data is required.');let bytes;try{bytes=Uint8Array.from(atob(context.args.dataBase64),c=>c.charCodeAt(0));}catch{throw new StorageError('invalid_args','Use a valid base64 byte payload.');}if(base64(bytes)!==context.args.dataBase64)throw new StorageError('invalid_args','Canonical base64 data is required.');if(bytes.length>1048576)throw new StorageError('body_too_large','This resource accepts files up to 1 MiB.',413);await this.admitWork(owner,{clientId:context.clientId});await reserveJournal();const value=await adapter.put({...context.args,bytes});result={object:{key:context.args.key,...value}};}else if(context.method==='delete'){await reserveJournal();result=await adapter.delete(context.args);}else throw new StorageError('unsupported_method','Google Drive does not support this operation.');}
      else {const config=await decryptSecret(resource.secret,this.config.KEY_ENCRYPTION_KEY);const options={allowedHosts:(this.config.ALLOWED_CONNECTOR_HOSTS||'').split(',').filter(Boolean)};const adapter=resource.provider==='s3'?new S3Adapter(config,options):new WebDAVAdapter(config,options);if(context.method==='capabilities')result=adapter.describe();else if(context.method==='get'){const value=await adapter.get(context.args);result={dataBase64:base64(value.bytes),object:{key:context.args.key,version:value.version,size:value.size??value.bytes.byteLength,contentType:value.contentType}};}else if(context.method==='presign')result=await adapter[context.method](context.args);else throw new StorageError('unsupported_method','This connector does not support that operation.');}
      if(assignedScope.maxObjectBytes&&context.method==='get'&&result.object?.size>assignedScope.maxObjectBytes)throw new StorageError('forbidden','The object exceeds the assigned byte limit.',403);
      if(context.method==='capabilities'&&Object.keys(assignedScope).length){result={...result,...assignedScope.readOnly?{write:false,delete:false,presigned:{...result.presigned,write:false}}:{},...assignedScope.prefix?{presigned:{read:false,write:false}}:{},...assignedScope.maxObjectBytes?{maxObjectBytes:Math.min(result.maxObjectBytes??1048576,assignedScope.maxObjectBytes),presigned:{read:false,write:false},...resource.provider!=='hosted'?{range:false}:{}}:{}};}
      if(!mutating)return result;
      const encoded=JSON.stringify(result);let saved={result};if(new TextEncoder().encode(encoded).byteLength>65536){const resultRef=`rpc-results/${owner}/${await archiveDigest(context.clientId)}/${context.tx}`;await this.blobs.put(resultRef,encoded,{storageAdmission:{clientId:context.clientId}});saved={resultRef};}await this.metadata.put(journalKey,{fingerprint,state:'done',...saved,createdAt:Date.now()});await this.metadata.put('lastResourceActiveAt',Date.now());return result;
    }catch(error){if(mutating&&journalReserved){const safe=error instanceof StorageError?{code:error.code,message:error.message,status:error.status,...Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?{retryAfter:error.retryAfter}:{}}:{code:'indeterminate',message:'Storage outcome is unknown; reconcile before retrying.',status:503};await this.metadata.put(journalKey,{fingerprint,state:'done',error:safe,createdAt:Date.now()});throw Object.assign(new StorageError(safe.code,safe.message,safe.status),safe.retryAfter?{retryAfter:safe.retryAfter}:{});}throw error;}
  },
  async migrateHostedIndex(resource){
    if(!this.itemIndex||await this.metadata.get(`hosted-index-ready/${resource.id}`))return;
    const cursor=await this.metadata.get(`hosted-index-cursor/${resource.id}`),prefix=`hosted/${resource.id}/`;
    const rows=await this.metadata.list({prefix,...cursor?{startAfter:cursor}:{},limit:200});
    await this.metadata.transaction(async tx=>{for(const [,object]of rows)this.itemIndex.upsertObject(resource.id,object);if(rows.size<200){await tx.put(`hosted-index-ready/${resource.id}`,true);await tx.delete(`hosted-index-cursor/${resource.id}`);}else await tx.put(`hosted-index-cursor/${resource.id}`,[...rows.keys()].at(-1));});
  },
  async hostedOperation(resource,method,args={},beforeEffect=async()=>{},clientId='@system'){
    if(method==='capabilities'){const {list:legacyList,...capabilities}=resource.capabilities;return capabilities;}
    if(method==='list')throw new StorageError('unsupported_method','Object storage has no listing operation; use application-managed directory objects.');
    objectKey(args.key);const path=`hosted/${resource.id}/${encodeURIComponent(args.key)}`,current=await this.metadata.get(path);
    if(method==='get'){
      if(!current)throw new StorageError('not_found','Object not found.',404);if(args.ifVersion!==undefined&&args.ifVersion!==current.version)throw new StorageError('conflict','Object changed.',409);
      const blob=await this.blobs.get(current.blobRef);if(!blob)throw new StorageError('temporarily_unavailable','Object data is temporarily unavailable.',503);let bytes=new Uint8Array(await blob.arrayBuffer());
      if(args.range){const {start,end}=args.range;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=bytes.length)throw new StorageError('invalid_args','Byte range is invalid.');bytes=bytes.slice(start,end+1);}const {blobRef,...object}=current;return {object,dataBase64:base64(bytes)};
    }
    if(method==='put'){
      if(args.condition?.absent===true?Boolean(current):typeof args.condition?.version!=='string'||args.condition.version!==current?.version)throw new StorageError('conflict','Object changed or the creation condition is missing.',409);
      if(typeof args.dataBase64!=='string'||args.dataBase64.length>1398104||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.dataBase64))throw new StorageError('invalid_args','Canonical base64 data is required.');
      const bytes=Uint8Array.from(atob(args.dataBase64),c=>c.charCodeAt(0));if(bytes.length>1048576)throw new StorageError('quota_exceeded','Objects are limited to one MiB.',429);
      if(args.contentType!==undefined&&(typeof args.contentType!=='string'||args.contentType.length>100||/[\r\n]/.test(args.contentType)))throw new StorageError('invalid_args','Content type is invalid.');
      const usage=await this.metadata.get('hosted-usage')||{bytes:0,objects:0};if(usage.objects+(!current?1:0)>1_000_000)throw new StorageError('quota_exceeded','The object count limit has been reached.',429);
      await this.quota.check(resource.owner,{bytes:bytes.length,replacedBytes:current?.size||0});await this.admitWork(resource.owner,{clientId});
      const version=crypto.randomUUID(),blobRef=`objects/${resource.owner}/${resource.id}/${version}`;
      const reservation=await this.quota.reserve(resource.owner,{id:version,bytes:bytes.length,replacedBytes:current?.size||0,blobRef,kind:'object'});
      try{
        await beforeEffect();
        await this.blobs.put(blobRef,bytes,{storageAdmission:{clientId}});
        const object={key:args.key,version,size:bytes.length,contentType:args.contentType||'application/octet-stream',modifiedAt:Date.now(),blobRef};
        await this.metadata.transaction(async tx=>{await tx.put(path,object);await tx.put('hosted-usage',{bytes:usage.bytes-(current?.size||0)+bytes.length,objects:usage.objects+(!current?1:0)});this.itemIndex?.upsertObject(resource.id,object);await this.quota.commit(tx,reservation.id);if(current)await tx.put(`blob-garbage/${crypto.randomUUID()}`,current.blobRef);});
        const {blobRef:privateRef,...publicObject}=object;return {object:publicObject};
      }finally{await this.quota.release(reservation.id);await this.scheduleAlarm(Date.now()+60000);}
    }
    if(method==='delete'){
      if(!current)throw new StorageError('not_found','Object not found.',404);if(typeof args.version!=='string'||current.version!==args.version)throw new StorageError('conflict','Object changed.',409);
      await beforeEffect();await this.metadata.transaction(async tx=>{const usage=await tx.get('hosted-usage');await tx.delete(path);if(usage)await tx.put('hosted-usage',{bytes:usage.bytes-current.size,objects:usage.objects-1});this.itemIndex?.removeObject(resource.id,args.key);await tx.put(`blob-garbage/${crypto.randomUUID()}`,current.blobRef);});await this.scheduleAlarm(Date.now()+60000);return {deleted:true};
    }
    throw new StorageError('unsupported_method','Hosted storage does not support that operation.');
  },
  async collectBlobGarbage({limit=32}={}){
    const retry=await this.metadata.get('storage/garbage-retry');if(!retryReady(retry))return {cleaned:0,paused:Boolean(retry?.paused)};let failed=false;const cursor=await this.metadata.get('blob-garbage-cursor');let rows=await this.metadata.list({prefix:'blob-garbage/',...cursor?{startAfter:cursor}:{},limit});if(!rows.size&&cursor)rows=await this.metadata.list({prefix:'blob-garbage/',limit});
    let cleaned=0;for(const [path,ref]of rows){try{await this.blobs.delete(ref);await this.metadata.delete(path);cleaned++;}catch{failed=true;/* Retain ownership of retryable garbage. */}}
    if(failed)await retryFailure(this.metadata,'storage/garbage-retry',null);else if(!(await this.metadata.list({prefix:'blob-garbage/',limit:1})).size)await this.metadata.delete('storage/garbage-retry');if(rows.size)await this.metadata.put('blob-garbage-cursor',[...rows.keys()].at(-1));return {cleaned};
  },
};

export const rpc={
 storageUsage:{},
 resources:{warm:true},
 addResource:{warm:true},
 verifyResource:{warm:true},
 deleteResource:{warm:true},
 googleDriveStart:{},
 googleDriveComplete:{},
 federationRPC:{activity:'resource-use'},
};

function base64(bytes){let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);}
function escapeRegex(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

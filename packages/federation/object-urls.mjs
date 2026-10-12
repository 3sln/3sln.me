import {objectKey} from '../storage/policy.mjs';
import {canonical,digest,base64url,boundedString} from '../messaging/store.mjs';
import {exact,object,fail} from './schema.mjs';
const CONTRACT='https://3sln.me/artefacts/contracts/object-storage/v1';
const key=(kind,id)=>`federation/${kind}/${id}`;
const copy=value=>structuredClone(value);
const encoded=bytes=>{let value='';for(let index=0;index<bytes.length;index+=8192)value+=String.fromCharCode(...bytes.subarray(index,index+8192));return btoa(value);};
const opaque=/^[A-Za-z0-9_-]{43}$/;
const normalizedScope=value=>{if(value?.prefix){try{objectKey(value.prefix.replace(/\/$/,''));}catch{fail('invalid_preferences');}}return ({...value?.prefix?{prefix:value.prefix.replace(/\/$/,'')}:{},...value?.readOnly===true?{readOnly:true}:{},...value?.maxObjectBytes!==undefined?{maxObjectBytes:value.maxObjectBytes}:{}});};
const reference=value=>object(value)?value.resource:value;
function range(value){if(value===undefined)return;exact(value,['start','end']);if(!Number.isSafeInteger(value.start)||!Number.isSafeInteger(value.end)||value.start<0||value.end<value.start||value.end>=1048576)fail('invalid_args','Use a bounded byte range.');return copy(value);}
function contentType(value){if(value===undefined)return 'application/octet-stream';if(!boundedString(value,100)||/[\r\n\x00-\x1f\x7f]/.test(value))fail('invalid_args','Use a valid content type.');return value;}
function fault(result){if(result?.__federationError)throw Object.assign(new Error(result.__federationError.message),result.__federationError);return result;}
/** One object, one fixed operation, one original field-bound authority. URL
 * delegation never retains the original bearer, private key or broad client
 * credential. Native links retain their explicitly disclosed TTL limitation. */
export class FederationObjectURLs{
 constructor(service,port){this.service=service;this.port=port;}
 async source(tx,hash,operation){
  const s=this.service,{token,grants}=await s.tokenRecord(tx,await tx.get(key('token',hash))),a=token.attenuation;
  if(!a)fail('forbidden','A field-bound resource token is required.');
  const preferences=await tx.get(key('preferences',`${token.subject}|${a.fragment}`)),schema=(await tx.get(key('schema',a.fragment)))?.schema,resource=await tx.get(key('resource',a.resource));
  if(!preferences||!schema||!resource||resource.owner!==token.subject||(resource.generation??null)!==a.generation||preferences.resourceRevisions?.[a.field]!==a.assignmentRevision||!Object.hasOwn(preferences.values,a.field))fail('forbidden');
  const value=preferences.values[a.field],assigned=(schema.fields[a.field].cardinality?.max??1)===1?[value]:value,assignment=assigned.find(value=>reference(value)===a.resource);
  if(!assignment||canonical(normalizedScope(object(assignment)?assignment.scope:{}))!==canonical(a.scope))fail('forbidden');
  const method=operation==='read'?'get':'put';
  const permitted=grants.some(grant=>grant.fragment===a.fragment&&grant.fields.includes(a.field)&&grant.digest===preferences.digest&&Object.hasOwn(grant.resources,a.field)&&grant.resources[a.field].includes(a.resource)&&(grant.resourceGenerations?.[a.resource]??null)===a.generation&&canonical(normalizedScope(grant.resourceScopes?.[a.field]?.[a.resource]??{}))===canonical(a.scope)&&grant.methods[a.field]?.[CONTRACT]?.includes('presign')&&grant.methods[a.field][CONTRACT].includes(method));
  if(!permitted||!resource.contracts[CONTRACT]?.includes(method)||!resource.contracts[CONTRACT]?.includes('presign')||operation==='write'&&a.scope.readOnly)fail('forbidden','This field does not permit the requested object URL.');
  return {token,resource};
 }
 async mint(bearer,envelope){
  const s=this.service,input=envelope.args;exact(input,['key','operation','expiresIn','size','contentType','condition','range','ifVersion']);
  try{objectKey(input.key);}catch{fail('invalid_args','Use a valid relative object key.');}if(!['read','write'].includes(input.operation))fail('invalid_args');const ttl=input.expiresIn??300;if(!Number.isInteger(ttl)||ttl<1||ttl>300)fail('invalid_args');
  const selectedRange=range(input.range);if(input.ifVersion!==undefined&&(!boundedString(input.ifVersion,2048)||/[\r\n]/.test(input.ifVersion)))fail('invalid_args');
  if(input.operation==='write'){if(!Number.isSafeInteger(input.size)||input.size<0||input.size>1048576||input.range!==undefined||input.ifVersion!==undefined)fail('invalid_args');exact(input.condition,['absent','version']);if(!((input.condition.absent===true&&Object.keys(input.condition).length===1)||(boundedString(input.condition.version,2048)&&Object.keys(input.condition).length===1)))fail('invalid_args','Choose an exact write condition.');contentType(input.contentType);}else if(input.size!==undefined||input.contentType!==undefined||input.condition!==undefined)fail('invalid_args');
  const hash=await digest(s.crypto,`token\0${bearer}`),mintKey=key('url-mint',`${encodeURIComponent(s.clients.get((await s.store.transaction(tx=>s.token(tx,bearer))).token.clientId).id)}/${envelope.tx}`),fingerprint=await digest(s.crypto,canonical(envelope));
  const reservation=await s.store.transaction(async tx=>{
   const {token,resource}=await this.source(tx,hash,input.operation);if(envelope.resource!==token.attenuation.reference)fail('forbidden');
   const previous=await tx.get(mintKey);if(previous&&previous.expiresAt>s.clock()){if(previous.fingerprint!==fingerprint)fail('tx_conflict');const record=await tx.get(key('object-url',previous.id));if(!record)fail('temporarily_unavailable');await this.source(tx,record.sourceHash,record.operation);return {record,replay:true};}
   await s.bounded(tx,'object-url',256);await s.bounded(tx,'url-mint',256);
   const expiresAt=Math.min(s.clock()+ttl*1000,token.expiresAt),id=base64url(s.crypto.getRandomValues(new Uint8Array(32)));if(expiresAt-s.clock()<1000)fail('invalid_grant');
   const maxBytes=Math.min(resource.limits?.maxObjectBytes??1048576,token.attenuation.scope.maxObjectBytes??1048576);if(input.operation==='write'&&input.size>maxBytes)fail('forbidden');
   const record={id,sourceHash:hash,owner:token.subject.split('/').at(-1),resource:token.attenuation.reference,key:input.key,operation:input.operation,expiresAt,status:input.operation==='read'?'minting':'ready',writeTx:s.crypto.randomUUID(),maxBytes,...selectedRange?{range:selectedRange}:{},...input.ifVersion!==undefined?{ifVersion:input.ifVersion}:{},...input.operation==='write'?{size:input.size,contentType:contentType(input.contentType),condition:copy(input.condition)}:{}};
   await tx.set(key('object-url',id),record);await tx.set(mintKey,{id,fingerprint,expiresAt});return {record,resource,replay:false};
  });
  let record=reservation.record;
  if(!reservation.replay&&record.operation==='read'){
   let native;
   // Full-object preflight proves both the advertised size bound and the
   // exact version. A native link must pin that version on every GET.
   if(reservation.resource.nativePresigned?.read&&!reservation.resource.scoping?.forceProxy&&this.port.seal&&this.port.open){
    const source=await s.store.transaction(tx=>this.source(tx,hash,'read'));
    if(!source.token.attenuation.scope.prefix&&!source.token.attenuation.scope.maxObjectBytes){
     try{
      const preflight=fault((await s.rpc(undefined,{version:'0',tx:s.crypto.randomUUID(),resource:record.resource,contract:CONTRACT,method:'get',args:{key:record.key,...record.ifVersion!==undefined?{ifVersion:record.ifVersion}:{}}},{tokenHash:hash,beforeEffect:()=>s.store.transaction(async tx=>{if(record.expiresAt<=s.clock())fail('unauthorized');await this.source(tx,hash,'read');})})).result);
      const version=preflight.object?.version,size=preflight.object?.size;
      if(Number.isSafeInteger(size)&&size<=record.maxBytes&&boundedString(version,2048)&&!version.startsWith('W/')&&!/[\r\n]/.test(version)){
       const result=await s.dispatchCapability({subject:source.token.subject,epoch:source.token.epoch,connection:source.token.connection,clientId:source.token.clientId,resource:source.token.attenuation.resource,addressedResource:record.resource,resourceGeneration:source.token.attenuation.generation,scope:source.token.attenuation.scope,contract:CONTRACT,method:'presign',reauthorize:()=>s.store.transaction(async tx=>{if(record.expiresAt<=s.clock())fail('unauthorized');await this.source(tx,hash,'read');}),args:{key:record.key,operation:'read',expiresIn:Math.floor((record.expiresAt-s.clock())/1000),ifVersion:version,...record.range?{range:record.range}:{}},tx:s.crypto.randomUUID()});
       const parsed=result?.url&&new URL(result.url),headers=result?.requiredHeaders;
       if(result.method==='GET'&&((record.range&&headers?.Range===`bytes=${record.range.start}-${record.range.end}`)||(!record.range&&!Object.hasOwn(headers??{},'Range')))&&parsed?.protocol==='https:'&&!parsed.username&&!parsed.password&&!parsed.hash&&result.url.length<=4096&&Number.isSafeInteger(result.expiresAt)&&result.expiresAt<=record.expiresAt&&result.expiresAt>s.clock()&&object(headers)&&headers['If-Match']===version&&Object.entries(headers).every(([name,value])=>['If-Match','Range'].includes(name)&&boundedString(value,2048)&&!/[\r\n]/.test(value)))native={url:result.url,method:'GET',expiresAt:result.expiresAt,requiredHeaders:copy(headers),mode:'native',revocation:'expires-only'};
      }
     }catch(error){if(['unauthorized','invalid_token','forbidden','invalid_grant'].includes(error.code))throw error;/* Non-native conditions use the checked proxy. */}
    }
   }
   await s.store.transaction(async tx=>{await this.source(tx,hash,'read');record=await tx.get(key('object-url',record.id));record.status='ready';if(native)record.native=await this.port.seal(native);await tx.set(key('object-url',record.id),record);});
  }
  if(record.status==='minting')fail('temporarily_unavailable','The object URL is still being prepared.');
  if(record.native)return this.port.open(record.native);
  return {url:await this.port.sign({owner:record.owner,id:record.id,operation:record.operation,expiresAt:record.expiresAt}),method:record.operation==='read'?'GET':'PUT',expiresAt:record.expiresAt,requiredHeaders:record.operation==='write'?{'Content-Type':record.contentType,...record.condition.absent?{'If-None-Match':'*'}:{'If-Match':record.condition.version}}:{},mode:'proxy',revocation:'live'};
 }
 async claims(input){
  exact(input,['owner','id','signature','operation','expiresAt','args']);if(!opaque.test(input.id??'')||!opaque.test(input.signature??''))fail('unauthorized');
  const s=this.service,url=`${s.issuer}/bindle/objects/${input.owner}/${input.id}?expires=${input.expiresAt}&sig=${input.signature}`;
  const claims=await this.port.verify(url,input.operation);if(s.routingKey&&claims.owner!==s.routingKey)fail('unauthorized');return claims;
 }
 async live(tx,claims){
  const record=await tx.get(key('object-url',claims.id));if(!record||record.owner!==claims.owner||record.operation!==claims.operation||record.expiresAt!==claims.expiresAt||record.expiresAt<=this.service.clock()||record.native||record.status==='minting')fail('unauthorized');await this.source(tx,record.sourceHash,record.operation);return record;
 }
 async inspect(input){const claims=await this.claims(input);await this.service.syncResources(`${this.service.issuer}/entities/${claims.owner}`);return this.service.store.transaction(async tx=>{const record=await this.live(tx,claims);return {expiresAt:record.expiresAt,...record.size!==undefined?{size:record.size}:{},...record.contentType?{contentType:record.contentType}:{},...record.condition?{condition:copy(record.condition)}:{},...record.range?{range:copy(record.range)}:{},...record.ifVersion?{ifVersion:record.ifVersion}:{}};});}
 async execute(input){
  const claims=await this.claims(input),s=this.service,args=input.args??{};await s.syncResources(`${s.issuer}/entities/${claims.owner}`);const record=await s.store.transaction(tx=>this.live(tx,claims));
  if(record.operation==='read'){
   exact(args,['range','ifVersion']);const selected=range(args.range??record.range);if(record.range&&selected&&(selected.start<record.range.start||selected.end>record.range.end)||record.ifVersion&&args.ifVersion!==undefined&&args.ifVersion!==record.ifVersion)fail('forbidden');
   const result=fault((await s.rpc(undefined,{version:'0',tx:s.crypto.randomUUID(),resource:record.resource,contract:CONTRACT,method:'get',args:{key:record.key,...record.ifVersion??args.ifVersion?{ifVersion:record.ifVersion??args.ifVersion}:{}}},{tokenHash:record.sourceHash,beforeEffect:()=>s.store.transaction(tx=>this.live(tx,claims))})).result);
   if(!Number.isSafeInteger(result.object?.size)||result.object.size>record.maxBytes)fail('forbidden','This object exceeds the delegated size limit.');
   if(selected){const bytes=Uint8Array.from(atob(result.dataBase64),char=>char.charCodeAt(0));if(selected.end>=bytes.length)fail('invalid_args','The byte range is outside the object.');return {...result,dataBase64:encoded(bytes.slice(selected.start,selected.end+1))};}return result;
  }
  exact(args,['dataBase64','contentType']);if(args.contentType!==record.contentType||typeof args.dataBase64!=='string'||args.dataBase64.length>1398104||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.dataBase64))fail('invalid_args','The upload does not match this object URL.');const bytes=Uint8Array.from(atob(args.dataBase64),char=>char.charCodeAt(0));if(bytes.length!==record.size||encoded(bytes)!==args.dataBase64)fail('invalid_args','The upload does not match this object URL.');
  const fingerprint=await digest(s.crypto,canonical(args)),reservation=await s.store.transaction(async tx=>{const current=await this.live(tx,claims);if(current.fingerprint&&current.fingerprint!==fingerprint)fail('tx_conflict');if(current.status==='done')return {result:current.result,error:current.error};if(current.status!=='ready')fail('indeterminate','The previous upload must be reconciled before retrying.');current.status='reserved';current.fingerprint=fingerprint;await tx.set(key('object-url',current.id),current);return {execute:true};});
  if(!reservation.execute){await s.store.transaction(tx=>this.live(tx,claims));if(reservation.error)throw Object.assign(new Error(reservation.error.message),reservation.error);return reservation.result;}
  try{
   const result=fault((await s.rpc(undefined,{version:'0',tx:record.writeTx,resource:record.resource,contract:CONTRACT,method:'put',args:{key:record.key,dataBase64:args.dataBase64,contentType:record.contentType,condition:record.condition}},{tokenHash:record.sourceHash,beforeEffect:()=>s.store.transaction(tx=>this.live(tx,claims))})).result);await s.store.transaction(async tx=>{const current=await tx.get(key('object-url',record.id));if(current){current.status='done';current.result=copy(result);await tx.set(key('object-url',record.id),current);}});return result;
  }catch(error){const known=['invalid_args','forbidden','conflict','quota_exceeded','account_quota_exceeded','rate_limited','storage_write_unavailable','unauthorized','invalid_token'].includes(error.code),safe={code:known?error.code:'indeterminate',message:'The upload could not be completed. Reconcile the object before retrying.',...Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?{retryAfter:error.retryAfter}:{}};await s.store.transaction(async tx=>{const current=await tx.get(key('object-url',record.id));if(current){current.status=known?'done':'indeterminate';current.error=safe;await tx.set(key('object-url',record.id),current);}});throw Object.assign(new Error(safe.message),safe);}
 }
}

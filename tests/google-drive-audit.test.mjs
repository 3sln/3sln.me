import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleDriveService} from '../packages/storage/google-drive.mjs';

const scope='https://www.googleapis.com/auth/drive.file',bytes=s=>new TextEncoder().encode(s);
class Metadata {
 rows=new Map(); tail=Promise.resolve();
 async get(k){return structuredClone(this.rows.get(k));}
 async put(k,v){this.rows.set(k,structuredClone(v));}
 async delete(k){this.rows.delete(k);}
 async list({prefix='',limit=Infinity,startAfter=''}={}){return new Map([...this.rows].filter(([k])=>k.startsWith(prefix)&&k>startAfter).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit));}
 async transaction(fn){const prior=this.tail;let done;this.tail=new Promise(r=>done=r);await prior;const snapshot=structuredClone(this.rows);try{return await fn(this);}catch(e){this.rows=snapshot;throw e;}finally{done();}}
}
function harness(){
 const metadata=new Metadata(),files=new Map(),calls=[];let next=0,now=1000000;
 const h={metadata,files,calls,hook:null,advance:n=>{now+=n;}};
 const fetcher=async(input,options={})=>{
  const url=new URL(input);calls.push({url,options});
  if(h.hook){const intercepted=await h.hook(url,options);if(intercepted)return intercepted;}
  if(url.hostname==='oauth2.googleapis.com')return url.pathname==='/revoke'?new Response(''):Response.json({access_token:'access',refresh_token:'refresh',token_type:'Bearer',expires_in:3600,scope});
  if(url.pathname==='/drive/v3/about')return Response.json({user:{permissionId:'principal_1'}});if(url.pathname.endsWith('/generateIds'))return Response.json({ids:['file_'+(++next)]});
  if(options.method==='POST'&&url.pathname==='/drive/v3/files'){const m=JSON.parse(options.body);files.set(m.id,{...m,owners:[{permissionId:'principal_1'}],capabilities:{canAddChildren:true},bytes:new Uint8Array(),trashed:false});return Response.json({id:m.id});}
  if(url.pathname==='/upload/drive/v3/files'){
   const raw=new TextDecoder().decode(options.body),start=raw.indexOf('{'),end=raw.indexOf('\r\n--',start),m=JSON.parse(raw.slice(start,end)),mediaStart=raw.indexOf('\r\n\r\n',end)+4,mediaEnd=raw.lastIndexOf('\r\n--');
   files.set(m.id,{id:m.id,bytes:bytes(raw.slice(mediaStart,mediaEnd)),parents:m.parents,mimeType:m.mimeType,version:'1',trashed:false});return Response.json({id:m.id});
  }
  const id=url.pathname.split('/').at(-1),file=files.get(id);if(!file)return new Response('',{status:404});
  return url.searchParams.get('alt')==='media'?new Response(file.bytes):Response.json({...file,bytes:undefined,size:String(file.bytes.length)});
 };
 h.service=new GoogleDriveService({metadata,fetcher,clock:()=>now,config:{APP_ORIGIN:'https://identity.example',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',KEY_ENCRYPTION_KEY:btoa('k'.repeat(32))}});
 h.clone=()=>new GoogleDriveService({metadata,fetcher,clock:()=>now,config:h.service.config});
 return h;
}
async function begin(h,session='session'){const start=await h.service.begin('owner',session);return {state:new URL(start.url).searchParams.get('state'),code:'code'};}
async function connect(h){return h.service.complete('owner','session',await begin(h));}
async function expire(h,r){const record=await h.metadata.get('resource/'+r.id);record.secret=await h.service.seal({...await h.service.open(record.secret),expiresAt:0});await h.metadata.put('resource/'+r.id,record);}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const errorCode=code=>e=>e.code===code;

test('Drive audit: state binds owner, replacement attempt, expiry and single consumption',async()=>{
 const h=harness(),first=await begin(h);
 await assert.rejects(h.service.complete('other','session',first),errorCode('oauth_state'));
 const second=await begin(h);await assert.rejects(h.service.complete('owner','session',first),errorCode('oauth_state'));
 h.advance(600001);await assert.rejects(h.service.complete('owner','session',second),errorCode('oauth_state'));
 const third=await begin(h),results=await Promise.allSettled([h.service.complete('owner','session',third),h.service.complete('owner','session',third)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(h.calls.filter(c=>c.url.pathname==='/token').length,1);
});

test('Drive audit: consent denial consumes matching state without contacting Google',async()=>{
 const h=harness(),request=await begin(h);await assert.rejects(h.service.complete('owner','session',{...request,error:'access_denied'}),errorCode('oauth_denied'));
 await assert.rejects(h.service.complete('owner','session',request),errorCode('oauth_expired'));assert.equal(h.calls.length,0);
});

test('Drive audit: malformed refresh token and excessive granted scope never create resources',async()=>{
 for(const token of [{refresh_token:{}},{scope:scope+' https://www.googleapis.com/auth/drive'},{scope:undefined}]){
  const h=harness(),request=await begin(h);h.hook=async url=>url.pathname==='/token'?Response.json({access_token:'access',refresh_token:'refresh',token_type:'Bearer',expires_in:3600,scope,...token}):null;
  await assert.rejects(h.service.complete('owner','session',request));assert.equal((await h.metadata.list({prefix:'resource/'})).size,0);
 }
});

test('Drive audit: failed refresh cannot resurrect a disconnected resource',async()=>{
 const h=harness(),r=await connect(h);await expire(h,r);const entered=deferred(),release=deferred();
 h.hook=async url=>{if(url.pathname==='/token'){entered.resolve();await release.promise;return new Response('',{status:400});}};
 const refreshing=h.service.access('owner',r.id);await entered.promise;await h.service.disconnect('owner',r.id);release.resolve();await assert.rejects(refreshing);
 assert.equal(await h.metadata.get('resource/'+r.id),undefined);
});

test('Drive audit: successful late refresh cannot replace a newer generation',async()=>{
 const h=harness(),r=await connect(h);await expire(h,r);const entered=deferred(),release=deferred();
 h.hook=async url=>{if(url.pathname==='/token'){entered.resolve();await release.promise;}};
 const refreshing=h.service.access('owner',r.id);await entered.promise;const newer=await h.metadata.get('resource/'+r.id);newer.generation='new-generation';await h.metadata.put('resource/'+r.id,newer);release.resolve();
 await assert.rejects(refreshing,errorCode('forbidden'));assert.equal((await h.metadata.get('resource/'+r.id)).generation,'new-generation');
});

test('Drive audit: reconnect-required resource still allows local disconnect',async()=>{
 const h=harness(),r=await connect(h),record=await h.metadata.get('resource/'+r.id);record.status='reauthorization_required';await h.metadata.put('resource/'+r.id,record);
 await h.service.disconnect('owner',r.id);assert.equal(await h.metadata.get('resource/'+r.id),undefined);
});

test('Drive audit: authorization precedes object presence and version checks',async()=>{
 const h=harness(),r=await connect(h);await h.service.put('owner',r.id,{key:'present',bytes:bytes('content'),condition:{absent:true}});
 for(const key of ['present','absent'])await assert.rejects(h.service.get('attacker',r.id,{key,ifVersion:'wrong'}),errorCode('forbidden'));
});

test('Drive audit: unauthorized put reveals no existing-key condition result',async()=>{
 const h=harness(),r=await connect(h);await h.service.put('owner',r.id,{key:'present',bytes:bytes('content'),condition:{absent:true}});
 for(const key of ['present','absent'])await assert.rejects(h.service.put('attacker',r.id,{key,bytes:bytes('x'),condition:{absent:true}}),errorCode('forbidden'));
});

test('Drive audit: missing upstream version cannot establish a stable read',async()=>{
 const h=harness(),r=await connect(h);await h.service.put('owner',r.id,{key:'root',bytes:bytes('original'),condition:{absent:true}});delete [...h.files.values()].find(f=>f.mimeType!=='application/vnd.google-apps.folder').version;
 await assert.rejects(h.service.get('owner',r.id,{key:'root'}));
});

test('Drive audit: malformed token type is a controlled invalid-response failure',async()=>{
 const h=harness(),request=await begin(h);h.hook=async url=>url.pathname==='/token'?Response.json({access_token:'access',refresh_token:'refresh',token_type:{unexpected:true},expires_in:3600,scope}):null;
 await assert.rejects(h.service.complete('owner','session',request),errorCode('invalid_response'));
});

test('Drive audit: stale refresh response cannot overwrite a newer encrypted token',async()=>{
 const h=harness(),r=await connect(h);await expire(h,r);const firstEntered=deferred(),secondEntered=deferred(),firstRelease=deferred(),secondRelease=deferred();let count=0;
 h.hook=async url=>{if(url.pathname!=='/token')return;const n=++count;if(n===1){firstEntered.resolve();await firstRelease.promise;}else{secondEntered.resolve();await secondRelease.promise;}return Response.json({access_token:'access-'+n,refresh_token:'refresh-'+n,token_type:'Bearer',expires_in:3600,scope});};
 const first=h.service.access('owner',r.id);await firstEntered.promise;const second=h.clone().access('owner',r.id);await secondEntered.promise;secondRelease.resolve();await second;firstRelease.resolve();await Promise.allSettled([first]);
 assert.equal((await h.service.open((await h.metadata.get('resource/'+r.id)).secret)).refreshToken,'refresh-2');
});

test('Drive audit: stale refresh rejection cannot disable a successfully refreshed connection',async()=>{
 const h=harness(),r=await connect(h);await expire(h,r);const firstEntered=deferred(),release=deferred();let count=0;
 h.hook=async url=>{if(url.pathname!=='/token')return;if(++count===1){firstEntered.resolve();await release.promise;return new Response('',{status:400});}return Response.json({access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600,scope});};
 const first=h.service.access('owner',r.id);await firstEntered.promise;await h.clone().access('owner',r.id);release.resolve();await assert.rejects(first);
 assert.equal((await h.metadata.get('resource/'+r.id)).status,'connected');
});

test('Drive audit: corrupted encrypted resource binding is rejected before egress',async()=>{
 const h=harness(),r=await connect(h),record=await h.metadata.get('resource/'+r.id),original=await h.service.open(record.secret);
 for(const delta of [{owner:'other'},{resourceId:'other'},{generation:'other'},{rootFolder:'https://evil.example/payload'}]){
  record.secret=await h.service.seal({...original,...delta});await h.metadata.put('resource/'+r.id,record);const before=h.calls.length;
  await assert.rejects(h.service.access('owner',r.id),errorCode('forbidden'));assert.equal(h.calls.length,before);
 }
});

test('Drive audit: independent controllers permit one stale-version publication winner',async()=>{
 const h=harness(),r=await connect(h),initial=await h.service.put('owner',r.id,{key:'root',bytes:bytes('first'),condition:{absent:true}});
 const results=await Promise.allSettled([h.service,h.clone()].map((s,i)=>s.put('owner',r.id,{key:'root',bytes:bytes('next'+i),condition:{version:initial.version}})));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='conflict').length,1);
});

test('Drive audit: moved object during download is rejected',async()=>{
 const h=harness(),r=await connect(h);await h.service.put('owner',r.id,{key:'root',bytes:bytes('original'),condition:{absent:true}});
 h.hook=async url=>{if(url.searchParams.get('alt')==='media')h.files.get(url.pathname.split('/').at(-1)).parents=['elsewhere'];};
 await assert.rejects(h.service.get('owner',r.id,{key:'root'}),errorCode('object_changed'));
});

test('Drive audit: ranged reads verify bytes outside requested range',async()=>{
 const h=harness(),r=await connect(h);await h.service.put('owner',r.id,{key:'root',bytes:bytes('original'),condition:{absent:true}});[...h.files.values()].find(f=>f.mimeType!=='application/vnd.google-apps.folder').bytes=bytes('originaX');
 await assert.rejects(h.service.get('owner',r.id,{key:'root',range:{start:0,end:2}}),errorCode('object_changed'));
});

test('Drive audit: unknown upload outcome retains pending identifier without publishing',async()=>{
 const h=harness(),r=await connect(h);h.hook=async url=>{if(url.pathname==='/upload/drive/v3/files')throw new Error('timeout after upstream accept');};
 await assert.rejects(h.service.put('owner',r.id,{key:'root',bytes:bytes('payload'),condition:{absent:true}}),errorCode('upstream_unavailable'));
 assert.equal((await h.metadata.list({prefix:'drive/object/'})).size,0);const pending=[...(await h.metadata.list({prefix:'drive/pending/'})).values()];assert.equal(pending.length,1);assert.match(pending[0].fileId,/^file_/);assert.equal(pending[0].generation,r.generation);
});

test('Drive audit: disconnect during upload prevents publication and retains pending evidence',async()=>{
 const h=harness(),r=await connect(h),entered=deferred(),release=deferred();h.hook=async url=>{if(url.pathname==='/upload/drive/v3/files'){entered.resolve();await release.promise;}};
 const write=h.service.put('owner',r.id,{key:'root',bytes:bytes('payload'),condition:{absent:true}});await entered.promise;await h.service.disconnect('owner',r.id);release.resolve();
 await assert.rejects(write,errorCode('forbidden'));assert.equal((await h.metadata.list({prefix:'drive/object/'})).size,0);assert.equal((await h.metadata.list({prefix:'drive/pending/'})).size,1);
});

test('Drive audit: all credentialed requests use fixed HTTPS hosts and reject redirects',async()=>{
 const h=harness(),r=await connect(h);await h.service.put('owner',r.id,{key:'root',bytes:bytes('payload'),condition:{absent:true}});await h.service.get('owner',r.id,{key:'root'});await h.service.disconnect('owner',r.id);
 for(const {url,options}of h.calls){assert.equal(url.protocol,'https:');assert(['www.googleapis.com','oauth2.googleapis.com'].includes(url.hostname));assert.equal(options.redirect,'error');}
});

test('Drive audit: late OAuth completion respects account resource cap',async()=>{
 const h=harness(),request=await begin(h);for(let i=0;i<100;i++)await h.metadata.put('resource/existing-'+i,{id:'existing-'+i,owner:'owner',provider:'hosted'});
 await assert.rejects(h.service.complete('owner','session',request),errorCode('resource_limit'));assert.equal((await h.metadata.list({prefix:'resource/'})).size,100);
});

test('Drive audit: pending upload cap blocks another remote upload',async()=>{
 const h=harness(),r=await connect(h);for(let i=0;i<100;i++)await h.metadata.put('drive/pending/'+r.id+'/pending-'+i,{fileId:'pending-'+i});
 const before=h.calls.filter(c=>c.url.pathname==='/upload/drive/v3/files').length;
 await assert.rejects(h.service.put('owner',r.id,{key:'root',bytes:bytes('payload'),condition:{absent:true}}),errorCode('upload_pending_limit'));
 assert.equal(h.calls.filter(c=>c.url.pathname==='/upload/drive/v3/files').length,before);
});

test('Drive audit: concurrent reconnects have one generation publication winner',async()=>{
 const h=harness(),r=await connect(h),requests=await Promise.all(['session-one','session-two'].map(async session=>{const started=await h.service.begin('owner',session,'Drive',{resourceId:r.id});return {session,input:{state:new URL(started.url).searchParams.get('state'),code:'renew'}};}));
 const results=await Promise.allSettled(requests.map(({session,input})=>h.clone().complete('owner',session,input)));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='reconnect_conflict').length,1);
 assert.equal((await h.metadata.list({prefix:'resource/'})).size,1);
});

test('Drive audit: disconnect during reconnect folder verification cannot revive resource',async()=>{
 const h=harness(),r=await connect(h),started=await h.service.begin('owner','session','Drive',{resourceId:r.id}),entered=deferred(),release=deferred();
 h.hook=async url=>{if(url.searchParams.get('fields')?.includes('canAddChildren')){entered.resolve();await release.promise;}};
 const renewal=h.service.complete('owner','session',{state:new URL(started.url).searchParams.get('state'),code:'renew'});await entered.promise;await h.clone().disconnect('owner',r.id);release.resolve();
 await assert.rejects(renewal,errorCode('reconnect_conflict'));assert.equal(await h.metadata.get('resource/'+r.id),undefined);
});

test('Drive audit: reconnect fences an upload from the previous credential generation',async()=>{
 const h=harness(),r=await connect(h),entered=deferred(),release=deferred();h.hook=async url=>{if(url.pathname==='/upload/drive/v3/files'){entered.resolve();await release.promise;}};
 const write=h.service.put('owner',r.id,{key:'root',bytes:bytes('old-generation'),condition:{absent:true}});await entered.promise;
 const started=await h.clone().begin('owner','renew-session','Drive',{resourceId:r.id});await h.clone().complete('owner','renew-session',{state:new URL(started.url).searchParams.get('state'),code:'renew'});release.resolve();
 await assert.rejects(write,errorCode('forbidden'));assert.equal((await h.metadata.list({prefix:'drive/object/'})).size,0);assert.equal((await h.metadata.list({prefix:'drive/pending/'})).size,1);
});

test('Drive audit: reconnect rejects altered root ownership and resource marker',async()=>{
 for(const delta of [{owners:[{permissionId:'other'}]},{appProperties:{bindleResource:'other'}},{capabilities:{canAddChildren:false}},{trashed:true}]){
  const h=harness(),r=await connect(h),before=await h.metadata.get('resource/'+r.id),secret=await h.service.open(before.secret),started=await h.service.begin('owner','session','Drive',{resourceId:r.id});Object.assign(h.files.get(secret.rootFolder),delta);
  await assert.rejects(h.service.complete('owner','session',{state:new URL(started.url).searchParams.get('state'),code:'renew'}),errorCode('root_changed'));assert.deepEqual(await h.metadata.get('resource/'+r.id),before);
 }
});

test('Drive audit: local disconnect removes credentials without revoking sibling Google authorization',async()=>{
 const h=harness(),removed=await connect(h),sibling=await connect(h),otherPrincipal=await connect(h),otherOwner=await connect(h);
 const principalRecord=await h.metadata.get('resource/'+otherPrincipal.id);principalRecord.secret=await h.service.seal({...await h.service.open(principalRecord.secret),permissionId:'principal_2'});await h.metadata.put('resource/'+otherPrincipal.id,principalRecord);
 const ownerRecord=await h.metadata.get('resource/'+otherOwner.id);ownerRecord.owner='different-owner';ownerRecord.secret=await h.service.seal({...await h.service.open(ownerRecord.secret),owner:'different-owner'});await h.metadata.put('resource/'+otherOwner.id,ownerRecord);
 const retained=await Promise.all([sibling,otherPrincipal,otherOwner].map(r=>h.metadata.get('resource/'+r.id))),callsBefore=h.calls.length;
 assert.deepEqual(await h.service.disconnect('owner',removed.id),{deleted:true,providerRevoked:false,localOnly:true});
 assert.equal(await h.metadata.get('resource/'+removed.id),undefined);assert.equal(h.calls.length,callsBefore);
 for(let i=0;i<retained.length;i++)assert.deepEqual(await h.metadata.get('resource/'+retained[i].id),retained[i]);
 await assert.rejects(h.service.access('owner',removed.id),errorCode('forbidden'));await h.service.access('owner',sibling.id);
 assert(!h.calls.some(c=>c.url.pathname==='/revoke'));
});

test('Drive audit: local disconnect does not need a working Google endpoint',async()=>{
 const h=harness(),r=await connect(h);h.hook=async()=>{throw Error('Google unavailable');};
 assert.deepEqual(await h.service.disconnect('owner',r.id),{deleted:true,providerRevoked:false,localOnly:true});assert.equal(await h.metadata.get('resource/'+r.id),undefined);
});

test('Drive audit: a stale disconnect cannot delete refreshed credentials',async()=>{
 const h=harness(),r=await connect(h),entered=deferred(),release=deferred(),open=h.service.open.bind(h.service);h.service.open=async value=>{const secret=await open(value);entered.resolve();await release.promise;return secret;};
 const removal=h.service.disconnect('owner',r.id);await entered.promise;const fresh=await h.metadata.get('resource/'+r.id);fresh.secret=await h.service.seal({...await open(fresh.secret),refreshToken:'new-refresh'});await h.metadata.put('resource/'+r.id,fresh);release.resolve();
 await assert.rejects(removal,errorCode('connection_conflict'));assert.deepEqual(await h.metadata.get('resource/'+r.id),fresh);
});

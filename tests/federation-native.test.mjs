import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createNodeServer} from '../apps/node/server.mjs';
import {federationAuthority} from '../packages/runtime/federation.mjs';
import {PREFERENCES,PROFILE} from '../packages/federation/index.mjs';
const origin='http://localhost:8788',clientOrigin='https://bindle-client.example',clientId=clientOrigin+'/client',redirectUri=clientOrigin+'/callback',fragment='https://schema.example/sync/v1',contract='https://3sln.me/artefacts/contracts/object-storage/v1';
const secondOrigin='https://other-client.example',secondId=secondOrigin+'/client',secondRedirect=secondOrigin+'/callback';
const clients=[{id:clientId,name:'Independent sync app',origin:clientOrigin,redirectUris:[redirectUri]},{id:secondId,name:'Second sync app',origin:secondOrigin,redirectUris:[secondRedirect]}];
const schema={id:fragment,title:'Sync preferences',description:'Select storage and a display name.',publisher:'https://schema.example',fields:{displayName:{title:'Display name',type:'string',maxLength:100},files:{title:'Storage',type:'resource',contracts:[contract]},self:{title:'Your profile',type:'resource',contracts:[PROFILE],cardinality:{min:0,max:1}}}};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'bindle-native-'));const config={APP_ORIGIN:origin,FEDERATION_ENABLED:'true',FEDERATION_CLIENTS:JSON.stringify(clients),FEDERATION_SCHEMAS:JSON.stringify({[fragment]:schema}),WORK_LIMITS_ENABLED:'false'};let app=await createNodeServer({directory,config});
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const request=(path,{method='GET',data,cookie,csrf,bearer,appOrigin}={})=>app.fetch(new Request(origin+path,{method,headers:{Origin:appOrigin??origin,...data!==undefined?{'Content-Type':'application/json'}:{},...cookie?{Cookie:cookie}:{},...csrf?{'X-CSRF-Token':csrf}:{},...bearer?{Authorization:`Bearer ${bearer}`}:{},'CF-Connecting-IP':'198.51.100.17'},...data!==undefined?{body:JSON.stringify(data)}:{}}));
 const post=(path,data,options={})=>request(path,{...options,method:'POST',data});
 const pending=await(await post('/api/auth/signup',{method:'password',password:'A durable federation test password!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'})).json();
 const recovery=await(await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken})).json();
 const activation=await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true});assert.equal(activation.status,200);const session=await activation.json(),cookie=activation.headers.get('Set-Cookie').split(';')[0],owner={cookie,csrf:session.csrfToken};
 const resourceResponse=await post('/api/resources',{provider:'hosted',name:'My sync files'},owner);assert.equal(resourceResponse.status,200);const resource=await resourceResponse.json(),resourceURI=`${origin}/entities/${session.account.id}/resources/${resource.id}`;
 const configure=async(scope={})=>{const current=(await(await request('/api/preferences',owner)).json()).preferences.find(p=>p.fragment===fragment);const response=await post('/api/preferences',{fragment,expectedRevision:current?.revision??null,values:{displayName:'Local owner',files:{resource:resourceURI,scope}}},owner);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));};
 await configure({prefix:'app/',maxObjectBytes:1024});
 const connect=async(selected=clients[0],methods=['capabilities','get','put','delete'])=>{const clientId=selected.id,redirectUri=selected.redirectUris[0],clientOrigin=selected.origin;const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');const response=await post('/api/oauth/requests',{clientId,redirectUri,challenge,challengeMethod:'S256',state:'browser-state',identity:`${session.account.handle}@localhost:8788`,requests:[{fragment,required:true,purpose:'Synchronize my files.',fields:['displayName','files'],methods:{files:{[contract]:methods}}}]},{appOrigin:clientOrigin});assert.equal(response.status,201,JSON.stringify(await response.clone().json()));assert.equal(response.headers.get('Access-Control-Allow-Origin'),clientOrigin);const pending=await response.json();const viewResponse=await request(`/api/oauth/requests/${pending.requestId}`,owner);assert.equal(viewResponse.status,200);const view=await viewResponse.json();assert.equal(view.authenticated,true);assert.ok(view.requests[0].resources.find(r=>r.id===resourceURI));const decision=await post(`/api/oauth/requests/${pending.requestId}/decision`,{requestId:pending.requestId,approved:[{fragment,revision:view.requests[0].revision,fields:['displayName','files'],resources:{files:[resourceURI]},methods:{files:{[contract]:methods}}}]},owner);assert.equal(decision.status,200,JSON.stringify(await decision.clone().json()));const callback=new URL((await decision.json()).redirectUri);assert.equal(callback.searchParams.get('iss'),origin);const exchange=()=>post('/oauth/token',{code:callback.searchParams.get('code'),verifier,clientId,redirectUri},{appOrigin:clientOrigin});const tokenResponse=await exchange();assert.equal(tokenResponse.status,200,JSON.stringify(await tokenResponse.clone().json()));assert.equal((await exchange()).status,400);return {token:await tokenResponse.json(),requestId:pending.requestId};};
 const rpc=(token,resource,contract,method,args={},tx=randomUUID(),appOrigin=clientOrigin)=>post('/bindle/rpc',{version:'0',tx,resource,contract,method,args},{bearer:token,appOrigin});
 return {get app(){return app;},owner,session,resourceURI,configure,connect,rpc,request,post,restart:async()=>{await app.close();app=await createNodeServer({directory,config});}};
}
test('native Node identity, preferences, consent and scoped object RPC survive restart and app disconnect revokes both tokens',async t=>{
 const f=await fixture(t),{token}=await f.connect();const preferences=await f.rpc(token.access_token,'@preferences',PREFERENCES,'read',{fragment});assert.equal(preferences.status,200,JSON.stringify(await preferences.clone().json()));const values=(await preferences.json()).result.values;assert.equal(values.displayName,'Local owner');assert.notEqual(values.files.token,token.access_token);const child=values.files.token,childURI=values.files.id;assert.equal(values.files.scope,undefined);assert.equal(values.files.label,undefined);assert.notEqual(childURI,f.resourceURI);
 const forbidden=await f.rpc(child,'@preferences',PREFERENCES,'read',{fragment});assert.equal(forbidden.status,403);
 assert.equal((await f.rpc(child,childURI,contract,'put',{key:'../outside.txt',dataBase64:'eA==',condition:{absent:true}})).status,400);
 const tx=randomUUID(),args={key:'file.txt',dataBase64:'aGVsbG8=',condition:{absent:true},contentType:'text/plain'};const put=await f.rpc(child,childURI,contract,'put',args,tx);assert.equal(put.status,200,JSON.stringify(await put.clone().json()));const result=(await put.json()).result;assert.equal(result.object.key,'file.txt');const version=result.object.version;
 const repeat=await f.rpc(child,childURI,contract,'put',args,tx);const replay=(await repeat.json()).result;assert.equal(replay.object.version,version);assert.equal(replay.object.key,'file.txt');
 await f.restart();const read=await f.rpc(child,childURI,contract,'get',{key:'file.txt'});assert.equal(read.status,200);const value=(await read.json()).result;assert.equal(value.dataBase64,'aGVsbG8=');assert.equal(value.object.key,'file.txt');
 const apps=await(await f.request('/api/apps',f.owner)).json();const list=apps.apps??apps;assert.equal(list[0].transport,'bindle');assert.equal((await f.request('/api/apps/'+list[0].id,{...f.owner,method:'DELETE'})).status,200);
 assert.equal((await f.rpc(token.access_token,'@preferences',PREFERENCES,'read',{fragment})).status,401);assert.equal((await f.rpc(child,childURI,contract,'get',{key:'file.txt'})).status,401);
});
test('native recovery epoch invalidates scalar reads and scope restoration cannot restore an old resource grant',async t=>{
 const f=await fixture(t),{token}=await f.connect();await f.configure({prefix:'other/'});await f.configure({prefix:'app/',maxObjectBytes:1024});const values=await(await f.rpc(token.access_token,'@preferences',PREFERENCES,'read',{fragment})).json();assert.deepEqual(values.result.requiresConsent,['files']);
 const account=await f.app.resources.repository.get(f.session.account.id),revision=account.revision;account.recoveryHash='rotated-recovery-authority';account.revision++;assert.equal(await f.app.resources.repository.compareAndSwap(account.id,revision,account),true);
 assert.equal((await f.rpc(token.access_token,'@preferences',PREFERENCES,'read',{fragment})).status,401);
});
test('unknown account locators never instantiate a federation shard',async()=>{
 let allocated=0;const authority=federationAuthority({config:{APP_ORIGIN:origin,FEDERATION_ENABLED:'true',FEDERATION_CLIENTS:clients},repository:{get:async()=>null},shard:()=>{allocated++;throw new Error('Unexpected allocation');}});const opaque=randomUUID()+'.'+'x'.repeat(43);
 for(const operation of [()=>authority.exchange({code:opaque}),()=>authority.rpc(opaque,{}),()=>authority.inspect(undefined,opaque),()=>authority.revoke({},opaque),()=>authority.configure({sessionToken:opaque},{}),()=>authority.grants({sessionToken:opaque}),()=>authority.preferences({sessionToken:opaque})])await assert.rejects(operation(),{code:'unauthorized'});
 assert.equal(allocated,0);
});
test('scoped proxy URLs attenuate operation, enforce uploads, survive restart and revoke with the originating grant',async t=>{
 const f=await fixture(t),{token}=await f.connect(clients[0],['capabilities','get','put','delete','presign']),ref=(await(await f.rpc(token.access_token,'@preferences',PREFERENCES,'read',{fragment})).json()).result.values.files;
 const mint=async(args,tx=randomUUID())=>{const response=await f.rpc(ref.token,ref.id,contract,'presign',args,tx);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const value=await response.json();assert.equal(value.error,undefined,JSON.stringify(value));return value.result;};
 const tx=randomUUID(),args={key:'share.txt',operation:'write',size:5,contentType:'text/plain',condition:{absent:true}},upload=await mint(args,tx);assert.equal(upload.mode,'proxy');assert.equal(upload.revocation,'live');assert.equal((await mint(args,tx)).url,upload.url);assert.equal(new URL(upload.url).pathname.includes('app'),false);
 const send=(url,method='GET',body,headers={})=>f.app.fetch(new Request(url,{method,headers,...body!==undefined?{body}:{}}));
 assert.equal((await send(upload.url,'GET')).status,401,'write capability cannot read');
 assert.equal((await send(upload.url,'PUT','hello',upload.requiredHeaders)).status,200);const replay=await send(upload.url,'PUT','hello',upload.requiredHeaders);assert.equal(replay.status,200);assert.equal((await send(upload.url,'PUT','other',upload.requiredHeaders)).status,409);
 const read=await mint({key:'share.txt',operation:'read'});assert.equal(read.method,'GET');assert.equal(read.mode,'proxy');assert.equal((await send(read.url,'PUT','hello',{...upload.requiredHeaders,Cookie:f.owner.cookie,Authorization:`Bearer ${token.access_token}`})).status,401,'ambient owner/app login cannot upgrade a read URL');
 await f.restart();const response=await send(read.url);assert.equal(response.status,200,await response.clone().text());assert.equal(await response.text(),'hello');assert.equal(response.headers.get('Content-Type'),'application/octet-stream');
 assert.equal((await send(read.url+'&extra=write')).status,401);assert.equal(read.url.includes('share.txt'),false,'logical key is privately bound, never encoded in the URL');
 assert.equal((await f.request('/api/grants/'+token.grants[0],{...f.owner,method:'DELETE'})).status,200);assert.equal((await send(read.url)).status,401);assert.equal((await send(upload.url,'PUT','hello',upload.requiredHeaders)).status,401,'replayed effects still require current authority');
});
test('presign permission without the underlying operation cannot mint read or write URLs',async t=>{
 const f=await fixture(t),{token}=await f.connect(clients[0],['capabilities','presign']),ref=(await(await f.rpc(token.access_token,'@preferences',PREFERENCES,'read',{fragment})).json()).result.values.files;
 for(const args of [{key:'file',operation:'read'},{key:'file',operation:'write',size:1,condition:{absent:true}}]){const response=await f.rpc(ref.token,ref.id,contract,'presign',args);assert.equal(response.status,403,JSON.stringify(await response.clone().json()));}
});
test('one reviewed scope save updates effective consumers, rejects stale fanout and cannot restore a revoked consumer',async t=>{
 const f=await fixture(t),a=(await f.connect()).token,b=(await f.connect(clients[1])).token;
 const read=async(token,appOrigin=clientOrigin)=>{const response=await f.rpc(token,'@preferences',PREFERENCES,'read',{fragment},randomUUID(),appOrigin);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));return (await response.json()).result.values.files;};
 const old=await read(a.access_token),other=await read(b.access_token,secondOrigin);assert.equal(old.id,other.id,'one shared assignment exposes the same stable scoped resource');assert.notEqual(old.token,other.token,'consumer authority remains separate');
 const state=()=>f.request('/api/preferences',f.owner).then(response=>response.json()).then(value=>value.preferences[0]);const stale=await state();assert.equal(stale.affectedApps.length,2);
 assert.equal((await f.request('/api/grants/'+b.grants[0],{...f.owner,method:'DELETE'})).status,200);
 const update=snapshot=>f.post('/api/preferences',{fragment,expectedRevision:snapshot.revision,reviewedConsumerDigest:snapshot.consumerDigest,updateShared:true,values:{displayName:'Reviewed update',files:{resource:f.resourceURI,scope:{prefix:'new/',readOnly:true,maxObjectBytes:1024}}}},f.owner);
 assert.equal((await update(stale)).status,409,'changing consumers invalidates displayed fanout approval');const fresh=await state();assert.equal(fresh.affectedApps.length,1);assert.equal((await update(fresh)).status,200);
 const current=await read(a.access_token);assert.notEqual(current.id,old.id);assert.equal((await f.rpc(old.token,old.id,contract,'capabilities')).status,403);
 const caps=await f.rpc(current.token,current.id,contract,'capabilities');assert.equal(caps.status,200);assert.equal((await caps.json()).result.write,false);
 assert.equal((await f.rpc(current.token,current.id,contract,'put',{key:'file',dataBase64:'eA==',condition:{absent:true}})).status,403);
 assert.equal((await f.rpc(b.access_token,'@preferences',PREFERENCES,'read',{fragment},randomUUID(),secondOrigin)).status,401);
});
test('native standard refresh rotation preserves scoped identity and reuse revokes parent and child capabilities',async t=>{
 const f=await fixture(t),original=(await f.connect()).token;assert.equal(typeof original.refresh_token,'string');assert.equal(original.refresh_expires_in,28800);
 const first=(await(await f.rpc(original.access_token,'@preferences',PREFERENCES,'read',{fragment})).json()).result.values.files;
 const renew=(refreshToken,client=clientId,appOrigin=clientOrigin)=>f.app.fetch(new Request(origin+'/oauth/token',{method:'POST',headers:{Origin:appOrigin,'Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':'198.51.100.17'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken,client_id:client})}));
 assert.equal((await renew(original.refresh_token,secondId,secondOrigin)).status,400,'wrong client cannot revoke another client family');
 const response=await renew(original.refresh_token);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const rotated=await response.json();assert.equal(rotated.subject,original.subject);assert.notEqual(rotated.access_token,original.access_token);assert.notEqual(rotated.refresh_token,original.refresh_token);
 const next=(await(await f.rpc(rotated.access_token,'@preferences',PREFERENCES,'read',{fragment})).json()).result.values.files;assert.equal(next.id,first.id,'resource identity remains stable through renewal');assert.notEqual(next.token,first.token);
 assert.equal((await renew(original.refresh_token)).status,400,'spent refresh replay revokes its family');
 for(const access of [original.access_token,rotated.access_token])assert.equal((await f.rpc(access,'@preferences',PREFERENCES,'read',{fragment})).status,401);
 for(const ref of [first,next])assert.equal((await f.rpc(ref.token,ref.id,contract,'capabilities')).status,401);
});
test('explicit profile resource consent exposes configured name/avatar without granting unrelated fields or contact disclosure',async t=>{
 const f=await fixture(t),profileURI=`${origin}/entities/${f.session.account.id}/profile`;
 const saved=await f.request('/api/profile',{...f.owner,method:'PUT',data:{displayName:'Profile owner',bio:'Private biography not in the baseline contract',avatar:'https://images.example/avatar.png',discloseToContacts:false}});assert.equal(saved.status,200);
 const state=(await(await f.request('/api/preferences',f.owner)).json()).preferences[0];
 assert.equal((await f.post('/api/preferences',{fragment,expectedRevision:state.revision,values:{...state.values,self:profileURI}},f.owner)).status,200);
 const verifier='p'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
 const pending=await(await f.post('/api/oauth/requests',{identity:`${f.session.account.handle}@localhost:8788`,clientId,redirectUri,challenge,challengeMethod:'S256',state:'profile-state',requests:[{fragment,required:true,purpose:'Show my chosen profile.',fields:['self'],methods:{self:{[PROFILE]:['read']}}}]},{appOrigin:clientOrigin})).json();
 const view=await(await f.request('/api/oauth/requests/'+pending.requestId,f.owner)).json();assert.equal(view.requests[0].resources.find(resource=>resource.id===profileURI).preview.name,'Profile owner');
 const approved=await f.post('/api/oauth/requests/'+pending.requestId+'/decision',{requestId:pending.requestId,approved:[{fragment,revision:view.requests[0].revision,fields:['self'],resources:{self:[profileURI]},methods:{self:{[PROFILE]:['read']}}}]},f.owner);assert.equal(approved.status,200);const callback=new URL((await approved.json()).redirectUri);
 const token=await(await f.post('/oauth/token',{clientId,redirectUri,code:callback.searchParams.get('code'),verifier},{appOrigin:clientOrigin})).json();
 const preferences=await(await f.rpc(token.access_token,'@preferences',PREFERENCES,'read',{fragment})).json();assert.deepEqual(Object.keys(preferences.result.values),['self']);const reference=preferences.result.values.self;assert.notEqual(reference.id,profileURI);assert.equal(reference.preview,undefined);
 const read=await f.rpc(reference.token,reference.id,PROFILE,'read');assert.equal(read.status,200);const value=(await read.json()).result;assert.equal(value.name,'Profile owner');assert.equal(value.avatar,'https://images.example/avatar.png');assert.equal(value.bio,undefined);assert.equal(value.email,undefined);
});

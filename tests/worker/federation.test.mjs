import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createHarness} from './harness.mjs';
import {PREFERENCES} from '../../packages/federation/index.mjs';
const appOrigin='https://app.example',clientId=appOrigin+'/client',redirectUri=appOrigin+'/callback',fragment='https://schema.example/files/v1',contract='https://3sln.me/artefacts/contracts/object-storage/v1';
async function fixture(t,overrides={}){
 const h=await createHarness({bindings:{...overrides,FEDERATION_ENABLED:'true',FEDERATION_CLIENTS:JSON.stringify([{id:clientId,name:'Actual Worker client',origin:appOrigin,redirectUris:[redirectUri]}]),FEDERATION_SCHEMAS:JSON.stringify({[fragment]:{id:fragment,title:'Files',description:'Select private sync storage.',publisher:'https://schema.example',fields:{files:{title:'Files',type:'resource',contracts:[contract]}}}})}});t.after(()=>h.close());
 const {result,cookie}=await h.signup(),owner=result.account.id,headers={Origin:h.origin,Cookie:cookie,'X-CSRF-Token':result.csrfToken};
 const json=async(response,status=200)=>{const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
 const post=(path,value,custom=headers)=>h.request(path,{method:'POST',headers:custom,value});
 const resource=await json(await post('/api/resources',{name:'Actual private files',provider:'hosted'})),resourceURI=`${h.origin}/entities/${owner}/resources/${resource.id}`;
 await json(await post('/api/preferences',{fragment,expectedRevision:null,values:{files:{resource:resourceURI,scope:{prefix:'private/',maxObjectBytes:1024}}}}));
 const verifier='w'.repeat(43),pending=await json(await post('/api/oauth/requests',{identity:`${result.account.handle}@localhost:8787`,clientId,redirectUri,challenge:createHash('sha256').update(verifier).digest('base64url'),challengeMethod:'S256',state:'worker-state',requests:[{fragment,required:true,purpose:'Synchronize my files.',fields:['files'],methods:{files:{[contract]:['capabilities','get','put','delete','presign']}}}]},{Origin:appOrigin}),201);
 const view=await json(await h.request('/api/oauth/requests/'+pending.requestId,{headers}));
 const decision=await json(await post('/api/oauth/requests/'+pending.requestId+'/decision',{requestId:pending.requestId,approved:[{fragment,revision:view.requests[0].revision,fields:['files'],resources:{files:[resourceURI]},methods:{files:{[contract]:['capabilities','get','put','delete','presign']}}}]}));
 const token=await json(await post('/oauth/token',{code:new URL(decision.redirectUri).searchParams.get('code'),verifier,clientId,redirectUri},{Origin:appOrigin}));
 const rpc=(bearer,resource,method,args={},protocol=contract,tx=randomUUID())=>post('/bindle/rpc',{version:'0',tx,resource,contract:protocol,method,args},{Origin:appOrigin,Authorization:`Bearer ${bearer}`});
 const preferences=()=>rpc(token.access_token,'@preferences','read',{fragment},PREFERENCES);
 const namespace=await h.mf.getDurableObjectNamespace('FEDERATION'),stub=namespace.get(namespace.idFromName('bindle-federation-v1/'+owner));
 return {h,owner,token,json,rpc,preferences,stub,refresh:refreshToken=>h.request('/oauth/token',{method:'POST',headers:{Origin:appOrigin,'Content-Type':'application/x-www-form-urlencoded'},form:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken,client_id:clientId})})};
}
test('actual sharded Worker consent, relative object RPC and refresh-family revocation enforce live SQLite/R2 authority',async t=>{
 const f=await fixture(t),ref=(await f.json(await f.preferences())).result.values.files;assert.equal(ref.scope,undefined);assert.match(ref.id,/\/resources\/scoped\//);assert.equal(typeof f.token.refresh_token,'string');
 const tx=randomUUID(),args={key:'data.txt',dataBase64:'d29ya2Vy',condition:{absent:true}};const put=(await f.json(await f.rpc(ref.token,ref.id,'put',args,contract,tx))).result;assert.equal(put.object.key,'data.txt');const replay=(await f.json(await f.rpc(ref.token,ref.id,'put',args,contract,tx))).result;assert.equal(replay.object.version,put.object.version);
 const read=(await f.json(await f.rpc(ref.token,ref.id,'get',{key:'data.txt'}))).result;assert.equal(read.object.key,'data.txt');assert.equal(read.dataBase64,args.dataBase64);
 const upload=(await f.json(await f.rpc(ref.token,ref.id,'presign',{key:'shared.txt',operation:'write',size:3,contentType:'text/plain',condition:{absent:true}}))).result;assert.equal(upload.mode,'proxy');const uploadRoute=new URL(upload.url).pathname+new URL(upload.url).search;
 assert.equal((await f.h.request(uploadRoute)).status,401);await f.json(await f.h.request(uploadRoute,{method:'PUT',raw:'abc',headers:upload.requiredHeaders}));await f.json(await f.h.request(uploadRoute,{method:'PUT',raw:'abc',headers:upload.requiredHeaders}));assert.equal((await f.h.request(uploadRoute,{method:'PUT',raw:'xyz',headers:upload.requiredHeaders})).status,409);
 const link=(await f.json(await f.rpc(ref.token,ref.id,'presign',{key:'shared.txt',operation:'read'}))).result;assert.equal(link.mode,'proxy');const readRoute=new URL(link.url).pathname+new URL(link.url).search,download=await f.h.request(readRoute);assert.equal(download.status,200,await download.clone().text());assert.equal(await download.text(),'abc');assert.equal(download.headers.get('Content-Type'),'application/octet-stream');assert.equal((await f.h.request(readRoute,{method:'PUT',raw:'abc',headers:upload.requiredHeaders})).status,401);
 const renewed=await f.json(await f.refresh(f.token.refresh_token));assert.notEqual(renewed.refresh_token,f.token.refresh_token);await f.json(await f.refresh(f.token.refresh_token),400);
 assert.equal((await f.rpc(renewed.access_token,'@preferences','read',{fragment},PREFERENCES)).status,401);assert.equal((await f.rpc(ref.token,ref.id,'get',{key:'data.txt'})).status,401);assert.equal((await f.h.request(readRoute)).status,401);assert.equal((await f.h.request(uploadRoute,{method:'PUT',raw:'abc',headers:upload.requiredHeaders})).status,401);
});
test('actual account-local Federation alarm prunes expired credentials while retaining private preferences and grants',async t=>{
 const f=await fixture(t);await f.json(await f.preferences());assert.ok(await f.stub.alarmAt());await f.stub.expireEphemeral();await f.stub.fireAlarm();const rows=await f.stub.rows();assert.ok(rows.some(([key])=>key.startsWith('federation/preferences/')));assert.ok(rows.some(([key])=>key.startsWith('federation/grant/')));assert.equal(rows.some(([key])=>/^federation\/(?:request|code|token|journal|refresh|family)\//.test(key)),false);assert.equal(rows.find(([key])=>key==='@federation-owner')[1],f.owner);
 assert.equal((await f.preferences()).status,401);
});
test('actual Worker signed uploads share the unified activity cap, return Retry-After and cannot charge completed replay again',async t=>{
 const f=await fixture(t,{STORAGE_WRITE_FREE_PER_DAY:'3'}),ref=(await f.json(await f.preferences())).result.values.files;
 const mint=async key=>(await f.json(await f.rpc(ref.token,ref.id,'presign',{key,operation:'write',size:1,condition:{absent:true}}))).result;
 const beforeRows=await f.h.accounts.get(f.h.accounts.idFromName(f.owner)).rows();assert.equal(beforeRows.find(([key])=>key==='storage-write/v1')[1].foreground.used,1);
 const first=await mint('one'),route=url=>new URL(url).pathname+new URL(url).search,upload=link=>f.h.request(route(link.url),{method:'PUT',raw:'x',headers:link.requiredHeaders});
 await f.json(await upload(first));await f.json(await upload(first));
 const second=await mint('two'),denied=await upload(second);assert.equal(denied.status,429,await denied.clone().text());assert.ok(Number(denied.headers.get('Retry-After'))>0);assert.match(denied.headers.get('Access-Control-Expose-Headers'),/Retry-After/);
 const rows=await f.h.accounts.get(f.h.accounts.idFromName(f.owner)).rows(),meter=rows.find(([key])=>key==='storage-write/v1')[1];assert.equal(meter.foreground.used,3);const bucket=await f.h.mf.getR2Bucket('BLOBS'),objects=await bucket.list({prefix:'objects/'+f.owner+'/'});assert.equal(objects.objects.length,1);
 const read=(await f.json(await f.rpc(ref.token,ref.id,'get',{key:'one'}))).result;assert.equal(read.dataBase64,'eA==');assert.equal((await upload(second)).status,429);assert.equal((await bucket.list({prefix:'objects/'+f.owner+'/'})).objects.length,1);
});

test('actual Worker brokering keys are provider-wide, persistent and absent with the default-off flag',async t=>{
 const clients=JSON.stringify([{id:clientId,name:'Broker fixture',origin:appOrigin,redirectUris:[redirectUri]}]);
 for(const flag of ['false','true']){
  const h=await createHarness({bindings:{FEDERATION_ENABLED:'true',FEDERATION_CLIENTS:clients,BROKERING_ENABLED:flag}});try{
   const response=await h.request('/oauth/brokering/jwks');assert.equal(response.status,flag==='true'?200:404);const manifest=await(await h.request('/.well-known/bindle/manifest.json')).json();
   if(flag==='false'){assert.equal(manifest.brokering_jwks_uri,undefined);continue;}
   const jwks=await response.json();assert.equal(jwks.keys.length,8);assert.ok(jwks.keys.every(k=>!k.d));assert.equal(manifest.brokering_jwks_uri,h.origin+'/oauth/brokering/jwks');assert.deepEqual(await(await h.request('/oauth/brokering/jwks')).json(),jwks);
  }finally{await h.close();}
 }
});

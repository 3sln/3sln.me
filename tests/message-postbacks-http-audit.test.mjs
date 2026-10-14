import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import application from '../packages/runtime/http.mjs';
import {IdentityFault} from '../packages/identity/index.mjs';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {appNotificationSigner} from '../packages/runtime/app-notifications.mjs';
import {federationEpoch} from '../packages/runtime/federation.mjs';
import {key,digest} from '../packages/messaging/store.mjs';
import {parseMessageForms} from '../packages/messaging/form-parser.mjs';
import {messageFormFingerprint} from '../packages/messaging/form-policy.mjs';

const issuer='https://provider.example', app='https://app.example';
const source='<form method="post" action="/submit"><input type="hidden" name="proof" value="bounded-app-proof"><input name="reply"><button>Send</button></form>';
const encoded=value=>new TextEncoder().encode(value);
// Real HTTP routing, durable account state, signatures and prepared capabilities.
// Identity authentication and outbound network are explicit local test ports.
async function fixture(t){
 const owner=crypto.randomUUID(),id=crypto.randomUUID(),directory=await mkdtemp(join(tmpdir(),'bindle-http-postback-audit-'));
 const db=new SqliteMetadata(join(directory,'state.sqlite')),blobs=new Map(),calls=[],rpc=[],lookups=[],identityCalls=[];
 const bucket={put:async(k,v)=>blobs.set(k,new Uint8Array(v)),get:async k=>blobs.has(k)?{arrayBuffer:async()=>blobs.get(k).buffer}:null,delete:async k=>blobs.delete(k)};
 const account={id:owner,status:'active',assignmentId:crypto.randomUUID(),recoveryHash:'private-initial-recovery-hash'};
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),kid=crypto.randomUUID();
 let response={status:204,headers:{},bytes:new Uint8Array()};
 const config={APP_ORIGIN:issuer,KEY_ENCRYPTION_KEY:Buffer.alloc(32,19).toString('base64'),WORK_LIMITS_ENABLED:'false',WORK_AUTHORITY:{consume:async()=>true},FORM_POSTBACK_ORIGINS:[app],FEDERATION_CLIENTS:[{id:app+'/client',name:'Fixture app',origin:app}],APP_NOTIFICATION_SIGNING_JWK:{...await crypto.subtle.exportKey('jwk',pair.privateKey),kid,alg:'ES256'},APP_NOTIFICATION_PUBLIC_JWKS:{keys:[{...await crypto.subtle.exportKey('jwk',pair.publicKey),kid,alg:'ES256'}]},FEDERATION_IDENTITY_CHECK:async(id,epoch)=>id===owner&&account.status==='active'&&epoch===await federationEpoch(account),FORM_POSTBACK_TRANSPORT:{send:async request=>{calls.push(request);return response;}}};
 const controller=new AccountController({metadata:db,gate:new SerialGate(),blobs:bucket,archives:bucket,config});await controller.touch(owner);
 const connectionId=crypto.randomUUID(),bytes=encoded(source),sourceDigest=await digest(crypto,bytes),blobRef=`messages/${owner}/${id}`,collection=(await controller.collections(owner))[0].id;
 await db.put('resource/'+connectionId,{id:connectionId,owner,kind:'app-connection',transport:'bindle',status:'active',clientId:app+'/client',appOrigin:app,generation:1,notifications:{enabled:true,generation:1}});
 const payload={version:1,purpose:'bindle-app-notification-admission-v1',issuer,owner,id,clientId:app+'/client',origin:app,name:'Fixture app',connectionId,connectionGeneration:1,notificationGeneration:1,bodyDigest:sourceDigest};
 const signer=await appNotificationSigner(config);blobs.set(blobRef,bytes);
 await db.put(key('message',owner,id),{id,owner,collection,mimeType:'text/html',size:bytes.length,blobRef,tags:[],readAt:null,quarantined:false,appNotification:{...payload,attestation:{alg:'ES256',kid,keysURL:issuer+'/.well-known/bindle/app-notification-keys.json',signature:await signer.sign(payload)}}});
 await db.put(key('message-usage',owner),{bytes:bytes.length,messages:1});
 const formDigest=await digest(crypto,messageFormFingerprint(parseMessageForms(source,app)[0]));
 const input=()=>({requestId:crypto.randomUUID(),expectedRevision:0,sourceDigest,formId:0,formDigest,fields:[['proof','bounded-app-proof'],['reply','Private submitted text']]});
 const env={...config,ABUSE:{consume:async()=>true},IDENTITY_REPOSITORY:{get:async value=>value===owner?account:null},IDENTITY_ENGINE:async()=>({dispose(){},query:query=>({peek:async()=>{identityCalls.push(query.context);if(query.context.sessionToken!=='owner-session')throw new IdentityFault('unauthorized');return {account:{id:owner,status:'active'},csrfToken:'owner-csrf'};}})}),ACCOUNTS:{get:value=>{lookups.push(value);assert.equal(value,owner);return {invoke:async call=>{rpc.push(call);return controller.invoke(call);}};}}};
 const request=(suffix,{method='POST',headers={},body={}}={})=>application.fetch(new Request(`${issuer}/api/messages/${id}${suffix}`,{method,headers:{'Content-Type':'application/json',...headers},...['GET','HEAD'].includes(method)?{}:{body:typeof body==='string'?body:JSON.stringify(body)}}),env);
 const ownerHeaders={Origin:issuer,Cookie:'__Host-bindle_session=owner-session','X-CSRF-Token':'owner-csrf'};
 const prepare=(value=input(),headers=ownerHeaders)=>request('/postbacks/prepare',{headers,body:value});
 const dispatch=(token,options={})=>request('/postbacks',{...options,headers:{Origin:issuer,Authorization:'Bearer '+token,...options.headers}});
 t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
 return {owner,id,db,account,controller,env,config,calls,rpc,lookups,identityCalls,input,sourceDigest,request,prepare,dispatch,ownerHeaders,setResponse:value=>{response=value;}};
}

test('HTTP prepare requires owner session, exact Origin and CSRF; only private identity supplies authority epoch',async t=>{
 const f=await fixture(t);
 for(const [headers,status] of [[{Origin:issuer},401],[{...f.ownerHeaders,Origin:'https://foreign.example'},403],[{...f.ownerHeaders,Origin:'null'},403],[{Cookie:f.ownerHeaders.Cookie,'X-CSRF-Token':'owner-csrf'},403],[{...f.ownerHeaders,'X-CSRF-Token':'wrong'},403]]){
  const r=await f.prepare(f.input(),headers);assert.equal(r.status,status);assert.equal(f.rpc.length,0);assert.equal(f.calls.length,0);
 }
 const r=await f.prepare();assert.equal(r.status,200);const cap=await r.json();assert(cap.dispatchToken);assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('Set-Cookie'),null);
 const call=f.rpc.find(r=>r.method==='messagePostbackPrepare');assert.equal(call.args[3],await federationEpoch(f.account));assert.notEqual(call.args[3],await federationEpoch({id:f.owner}));assert(!JSON.stringify(cap).includes(f.account.recoveryHash));
 assert.equal((await f.prepare({...f.input(),authorityEpoch:'forged'})).status,400);assert.equal(f.calls.length,0);
});

test('HTTP dispatch rejects cookies, foreign/opaque/missing origins and forged scoped MACs before any actor access',async t=>{
 const f=await fixture(t),cap=await (await f.prepare()).json();f.lookups.length=0;f.rpc.length=0;f.identityCalls.length=0;
 for(const headers of [{Cookie:''},{Cookie:f.ownerHeaders.Cookie},{Origin:'null'},{Origin:'https://foreign.example'},{Origin:issuer+'/'}])assert.equal((await f.dispatch(cap.dispatchToken,{headers})).status,403);
 assert.equal((await f.request('/postbacks',{headers:{Authorization:'Bearer '+cap.dispatchToken}})).status,403);
 const parts=cap.dispatchToken.split('.');
 for(const [index,value]of [[0,crypto.randomUUID()],[1,'A'.repeat(43)],[2,String(Date.now()-1)],[2,String(Date.now()+240000)],[3,'A'.repeat(43)]]){const changed=[...parts];changed[index]=value;assert.equal((await f.dispatch(changed.join('.'))).status,401);}
 const wrongMessage=await application.fetch(new Request(`${issuer}/api/messages/${crypto.randomUUID()}/postbacks`,{method:'POST',headers:{Origin:issuer,Authorization:'Bearer '+cap.dispatchToken,'Content-Type':'application/json'},body:'{}'}),f.env);assert.equal(wrongMessage.status,401);
 for(const [options,status]of [[{method:'GET'},405],[{body:{fields:[['reply','replaced']]}},400],[{body:'[]'},400],[{body:{padding:'a'.repeat(129)}},413],[{headers:{'Content-Type':'text/plain'}},415]])assert.equal((await f.dispatch(cap.dispatchToken,options)).status,status);
 assert.deepEqual(f.lookups,[]);assert.deepEqual(f.rpc,[]);assert.deepEqual(f.identityCalls,[]);assert.equal(f.calls.length,0);
});

test('HTTP cookie-free dispatch retains outcome without owner login, leaked credentials, automatic redirects or a second send',async t=>{
 const f=await fixture(t);f.setResponse({status:303,headers:{location:'https://next.example/result'},bytes:new Uint8Array()});
 const cap=await (await f.prepare()).json();f.identityCalls.length=0;f.rpc.length=0;
 const r=await f.dispatch(cap.dispatchToken);assert.equal(r.status,200);const result=await r.json();assert.equal(result.type,'redirect');assert.equal(result.location,'https://next.example/result');assert.equal(r.headers.get('Location'),null);assert.equal(r.headers.get('Set-Cookie'),null);assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
 assert.deepEqual(await (await f.dispatch(cap.dispatchToken)).json(),result);assert.equal(f.calls.length,1);assert.deepEqual(f.identityCalls,[]);assert(f.rpc.every(r=>r.method==='messagePostbackDispatch'));
 assert.deepEqual(Object.keys(f.calls[0].headers).sort(),['Content-Type','Idempotency-Key']);assert.equal(f.calls[0].url,app+'/submit');assert(!JSON.stringify(f.calls[0]).includes('owner-session'));assert.equal((await f.controller.message(f.owner,f.id)).presentation.current,null);
});

test('HTTP prepared authority is invalidated by recovery, inactive identity and edited unsigned presentation',async t=>{
 const f=await fixture(t),cap=await (await f.prepare()).json(),initial=f.account.recoveryHash;
 f.account.recoveryHash='new-recovery-authority';assert.equal((await f.dispatch(cap.dispatchToken)).status,403);assert.equal(f.calls.length,0);
 f.account.recoveryHash=initial;f.account.status='recovering';assert.equal((await f.dispatch(cap.dispatchToken)).status,403);assert.equal((await f.prepare()).status,401);assert.equal(f.calls.length,0);
 f.account.status='active';const edit=await f.request('/presentation',{headers:f.ownerHeaders,body:{requestId:crypto.randomUUID(),expectedRevision:0,sourceDigest:f.sourceDigest,mimeType:'text/html',text:source}});assert.equal(edit.status,200);
 const denied=await f.dispatch(cap.dispatchToken);assert.equal(denied.status,403);assert.equal((await denied.json()).error,'unverified_presentation');assert.equal(f.calls.length,0);
 const detail=await f.request('',{method:'GET',headers:f.ownerHeaders});assert.equal((await detail.json()).formPostbacks.reason,'unverified-presentation');
});

test('HTTP status results preserve only at most two bounded HTTPS navigation links and cannot turn HTTP failure into success',async t=>{
 const f=await fixture(t),actions=[{label:'Help',href:'https://help.example/answer'},{label:'Details',href:'https://app.example/result'}];
 for(const [status,payload,expected]of [[200,{type:'info',message:'Done',actions},'info'],[403,{type:'success',message:'Denied',actions},'error'],[200,{type:'success',message:'Too many',actions:[...actions,actions[0]]},'error'],[200,{type:'info',message:'Unsafe',actions:[{label:'Run',href:'javascript:alert(1)'}]},'error'],[200,{type:'info',message:'User info',actions:[{label:'Run',href:'https://private@app.example/'}]},'error']]){
  f.setResponse({status,headers:{contentType:'application/vnd.bindle.submission-status+json'},bytes:encoded(JSON.stringify(payload))});
  const view=await f.controller.message(f.owner,f.id),input={...f.input(),expectedRevision:view.presentation.revision};const preparation=await f.prepare(input);assert.equal(preparation.status,200);const cap=await preparation.json();const r=await f.dispatch(cap.dispatchToken);assert.equal(r.status,200);const result=await r.json();assert.equal(result.type,'status');assert.equal(result.toast.type,expected);
  if(payload.message==='Done'||payload.message==='Denied')assert.deepEqual(result.toast.actions,actions);else assert.equal(result.toast.actions,undefined);
 }
 assert.equal(f.calls.length,5);assert.equal((await f.controller.message(f.owner,f.id)).presentation.current,null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
const ORIGIN='https://3sln.example';
async function fixture(t,enabled='true'){
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),secret=JSON.stringify({kid:'bridge-local-test',privateJWK:await crypto.subtle.exportKey('jwk',pair.privateKey)});
 const h=await createHarness({assets:async()=>new Response(null,{status:404}),bindings:{APP_ORIGIN:ORIGIN,RP_ID:'3sln.example',EMAIL_BRIDGE_ENABLED:enabled,BINDLEBOX_ENABLED:'true',EMAIL_BRIDGE_SIGNING_JWK:secret}});t.after(()=>h.close());return {...h,secret};
}
test('BRIDGE workerd: real object settings, default opt-out, paid entitlement and owner/CSRF gates; public keys contain no private material',async t=>{
 const h=await fixture(t),{cookie,result}=await h.signup(),owner=result.account.id,account=h.accounts.get(h.accounts.idFromName(owner));
 const ownerHeaders={Cookie:cookie,Origin:ORIGIN,'X-CSRF-Token':result.csrfToken};
 let r=await h.request('/api/email-bridge',{headers:ownerHeaders});assert.equal(r.status,200);assert.deepEqual(await r.json(),{enabled:false,autoReply:true,revision:0});
 r=await h.request('/api/email-bridge',{method:'PUT',value:{enabled:true},headers:ownerHeaders});assert.equal(r.status,403);
 await account.seed(owner,[['billing/state',{owner,source:'polar',catalogVersion:2,plan:'paid',validUntil:Date.now()+3600000}]]);
 assert.equal(await account.invoke({method:'emailBridgeEntitled',args:[owner]}),true);
 assert.equal(await account.invoke({method:'integrationsIntakeSeat',args:[owner]}).then(r=>r?.$fault?.code??r),null,'other integration flags still fail closed');
 r=await h.request('/api/email-bridge',{method:'PUT',value:{enabled:true},headers:{Cookie:cookie}});assert.equal(r.status,403);
 r=await h.request('/api/email-bridge',{method:'PUT',value:{enabled:true},headers:ownerHeaders});assert.equal(r.status,200);assert.equal((await r.json()).enabled,true);
 r=await h.request('/api/email-bridge/accepted',{method:'POST',value:{jti:'unknown'},headers:ownerHeaders});assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:'suppressed'});
 r=await h.request('/api/email-bridge');assert.equal(r.status,401);
 for(const path of ['/.well-known/bindle/email-bridge-keys.json','/keys/email-bridge/bridge-local-test']){
  r=await h.request(path);assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'*');const value=await r.json(),key=value.keys?.[0]??value;assert.equal(key.kid,ORIGIN+'/keys/email-bridge/bridge-local-test');assert.deepEqual(Object.keys(key).sort(),['alg','crv','key_ops','kid','kty','use','x','y']);
  const imported=await crypto.subtle.importKey('jwk',key,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);assert.equal(imported.type,'public');
 }
});
test('BRIDGE workerd: flags off hide owner settings and key publication; account entitlement is false',async t=>{
 const h=await fixture(t,'false'),{cookie,result}=await h.signup();
 for(const path of ['/api/email-bridge','/.well-known/bindle/email-bridge-keys.json','/keys/email-bridge/bridge-local-test'])assert.equal((await h.request(path,{headers:{Cookie:cookie}})).status,404,path);
 const account=h.accounts.get(h.accounts.idFromName(result.account.id));assert.equal(await account.invoke({method:'emailBridgeEntitled',args:[result.account.id]}),false);
});

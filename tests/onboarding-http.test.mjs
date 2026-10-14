import test from 'node:test';
import assert from 'node:assert/strict';
import application from '../packages/runtime/http.mjs';
const origin='https://personal.example';
const request=(path,options={})=>new Request(origin+path,options);
function fixture(){
 let identityCalls=0;const assets=[];
 const env={APP_ORIGIN:origin,LOCAL_DEVELOPMENT:'true',SIGNUP_ENABLED:'false',RECOVERY_SIGNING_KEY:'test-configured-key',ONBOARDING_ENABLED:'false',ASSETS:{fetch:async r=>{assets.push(new URL(r.url).pathname);return new Response('<!doctype html><title>Private console</title>',{headers:{'Content-Type':'text/html'}});}},IDENTITY_ENGINE:()=>{identityCalls++;throw Error('Must not access identities');}};
 return {env,assets,count:()=>identityCalls};
}
test('explicitly closed public signup stays closed even in local development',async()=>{
 const f=fixture();const config=await(await application.fetch(request('/api/config'),f.env)).json();
 assert.equal(config.signupEnabled,false);
 const response=await application.fetch(request('/api/auth/signup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}),f.env);
 assert.equal(response.status,503);assert.equal(f.count(),0);
});
test('private invitation navigation serves a no-store console without identity effects',async()=>{
 const f=fixture();
 for(const method of ['GET','HEAD']){
  const response=await application.fetch(request('/token-onboarding?lang=es',{method}),f.env);
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
  assert.match(response.headers.get('X-Robots-Tag')??'',/noindex/);
  assert.equal(response.headers.get('Set-Cookie'),null);
  if(method==='HEAD')assert.equal(await response.text(),'');
 }
 assert.equal(f.count(),0);assert.deepEqual(f.assets,['/console.html','/console.html']);
 const rejected=await application.fetch(request('/token-onboarding',{method:'POST'}),f.env);
 assert.equal(rejected.status,405);assert.equal(f.count(),0);
});
test('unconfigured private onboarding cannot construct an identity engine',async()=>{
 const f=fixture();
 for(const path of ['/api/auth/onboarding/begin','/api/auth/onboarding/inspect','/api/auth/onboarding/claim','/api/auth/onboarding/issue']){
  const response=await application.fetch(request(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}),f.env);
  assert.equal(response.status,503,path);assert.equal(f.count(),0);
 }
});

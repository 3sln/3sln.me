import test from 'node:test';import assert from 'node:assert/strict';import {createHarness} from './harness.mjs';
test('first secret-free deployment exposes public drafts and blocks account creation, MCP and demo routes',async t=>{
 const h=await createHarness({bindings:{APP_ORIGIN:'https://3sln.me',RP_ID:'3sln.me',LOCAL_DEVELOPMENT:'false',RELEASE_READY:'false',MCP_ENABLED:'false',KEY_ENCRYPTION_KEY:'',ABUSE_HASH_KEY:''}});t.after(()=>h.close());
 const call=(path,options={})=>h.mf.dispatchFetch('https://3sln.me'+path,options);
 const config=await(await call('/api/config')).json();assert.equal(config.localDevelopment,false);assert.equal(config.signupEnabled,false);assert.equal(config.providers.google.enabled,false);
 const signup=await call('/api/auth/signup',{method:'POST',headers:{Origin:'https://3sln.me','Content-Type':'application/json'},body:JSON.stringify({handle:'bootstrap_test',method:'password',password:'long test password',termsAccepted:true})});assert.equal(signup.status,503);assert.equal((await signup.json()).error,'release_gated');
 for(const path of ['/mcp','/mcp/oauth/authorize?client_id=x'])assert.equal((await call(path)).status,503);
 assert.equal((await call('/api/demo')).status,404);assert.equal((await call('/.well-known/bindle/manifest.json')).status,503);
});

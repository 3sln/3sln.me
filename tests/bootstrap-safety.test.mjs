import test from 'node:test';import assert from 'node:assert/strict';import application from '../packages/runtime/http.mjs';
test('public unsubscribe cannot allocate arbitrary account objects before identity existence',async()=>{
 let accountDispatches=0,identityLookups=0;const env={APP_ORIGIN:'https://3sln.me',RELEASE_READY:'false',IDENTITY_REPOSITORY:{get:async()=>{identityLookups++;return null;}},ACCOUNTS:{get:()=>{accountDispatches++;throw Error('Must not allocate account object');}}};
 const response=await application.fetch(new Request('https://3sln.me/api/notifications/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:crypto.randomUUID(),token:'a'.repeat(43)})}),env,{});assert.equal(response.status,400);assert.equal((await response.json()).error,'invalid_unsubscribe');assert.equal(identityLookups,1);assert.equal(accountDispatches,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.mjs';
import {verifyAccessToken} from '../../packages/federation/signing.mjs';
import {verifySecurityEventToken,INTEGRATION_EVENT_TYPES} from '../../packages/runtime/integration-events.mjs';
const issuer='https://provider.example',owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(t,flags){
 const h=await createHarness({bindings:{APP_ORIGIN:issuer,...flags}});t.after(()=>h.close());const federation=await h.mf.getDurableObjectNamespace('FEDERATION');return {account:h.accounts.get(h.accounts.idFromName(owner)),keys:federation.get(federation.idFromName('bindle-brokering-v1'))};
}
test('actual Worker composition keeps Wave 4 ports off by default',async t=>{
 const {account}=await fixture(t,{});assert.deepEqual((await account.wave4Composition()).ports,{event:false,egress:false,snapshot:false,mint:false,discovery:false,describe:false,grant:false});
});
test('actual Worker composition signs SETs and discovery tokens through the persistent brokering object',async t=>{
 const {account,keys}=await fixture(t,{INTEGRATIONS_ENABLED:'true',BROKERING_ENABLED:'true',BINDLEBOX_ENABLED:'true'});assert.deepEqual((await account.wave4Composition()).ports,{event:true,egress:true,snapshot:true,mint:true,discovery:true,describe:true,grant:true});
 const subject=issuer+'/entities/'+owner,audience='https://integration.example/bindle/resources',{mint:{token}}=await account.wave4Composition({mint:{subject,audience,purpose:'discover',connection:'connection-1',generation:1,lifetime:60}});const jwks=JSON.parse(JSON.stringify(await keys.brokeringJwks()));assert.equal((await verifyAccessToken(token,{keys:jwks,issuer,audience,purposes:['discover']})).claims.client_id,issuer);
 const endpoint='https://integration.example/bindle/events',claims={iss:issuer,sub:subject,aud:endpoint,iat:Math.floor(Date.now()/1000),jti:'B'.repeat(22),events:{[INTEGRATION_EVENT_TYPES['connection-revoked']]:{connection:'connection-1',generation:2,seq:1,generation_floor:2,terminal:true}}},{event:{token:set}}=await account.wave4Composition({event:claims});assert.deepEqual((await verifySecurityEventToken(set,{keys:jwks,issuer,audience:endpoint,subject,connection:({connection})=>connection==='connection-1'})).claims,claims);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import application from '../packages/runtime/http.mjs';
const issuer='https://provider.example',clientOrigin='https://app.example',clientId=clientOrigin+'/client';
test('federation read and RPC traffic cannot exhaust consent admission; mutation rejection remains retryable and CORS readable',async()=>{
 const counts=new Map();const controller={clients:[{id:clientId,origin:clientOrigin}],ready:async()=>true,manifest:async()=>({version:'0',issuer}),beginAuthorization:async()=>({requestId:'x'.repeat(43)}),tokenClient:async()=>clientId,rpc:async()=>({version:'0',result:{}})};
 const env={APP_ORIGIN:issuer,FEDERATION_ENABLED:'true',FEDERATION_AUTHORITY:controller,KEY_ENCRYPTION_KEY:'isolated-http-rate-test',ABUSE:{consume:async(key,{limit})=>{const next=(counts.get(key)??0)+1;counts.set(key,next);return next<=limit;}}};
 const request=(path,data,bearer)=>application.fetch(new Request(issuer+path,{method:data===undefined?'GET':'POST',headers:{Origin:clientOrigin,'CF-Connecting-IP':'198.51.100.11',...data===undefined?{}:{'Content-Type':'application/json'},...bearer?{Authorization:'Bearer fixture-token'}:{}},...data===undefined?{}:{body:JSON.stringify(data)}}),env);
 for(let i=0;i<40;i++)assert.equal((await request('/.well-known/bindle/manifest.json')).status,200);
 assert.equal((await request('/api/oauth/requests',{clientId})).status,201);
 for(let i=0;i<29;i++)assert.equal((await request('/api/oauth/requests',{clientId})).status,201);
 const rejected=await request('/api/oauth/requests',{clientId});assert.equal(rejected.status,429);assert.equal(rejected.headers.get('Retry-After'),'60');assert.equal(rejected.headers.get('Access-Control-Allow-Origin'),clientOrigin);
 assert.equal((await request('/bindle/rpc',{},true)).status,200);
});

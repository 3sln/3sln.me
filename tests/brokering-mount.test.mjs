import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNodeServer} from '../apps/node/server.mjs';
const origin='http://localhost:8791',client={id:'https://broker-client.example/client',name:'Broker client',origin:'https://broker-client.example',redirectUris:['https://broker-client.example/callback']};
test('Node mounts provider brokering JWKS only with its flag and preserves its purpose keys across restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'bindle-brokering-')),config={APP_ORIGIN:origin,FEDERATION_ENABLED:'true',FEDERATION_CLIENTS:JSON.stringify([client])};let app;
 const fetch=path=>app.fetch(new Request(origin+path));
 try{
  app=await createNodeServer({directory,config});assert.equal((await fetch('/oauth/brokering/jwks')).status,404);assert.equal((await(await fetch('/.well-known/bindle/manifest.json')).json()).brokering_jwks_uri,undefined);await app.close();
  app=await createNodeServer({directory,config:{...config,BROKERING_ENABLED:'true'}});const response=await fetch('/oauth/brokering/jwks');assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');const jwks=await response.json();assert.equal(jwks.keys.length,8);assert.ok(jwks.keys.every(k=>k.d===undefined));assert.equal((await(await fetch('/.well-known/bindle/manifest.json')).json()).brokering_jwks_uri,origin+'/oauth/brokering/jwks');await app.close();
  app=await createNodeServer({directory,config:{...config,BROKERING_ENABLED:'true'}});assert.deepEqual(await(await fetch('/oauth/brokering/jwks')).json(),jwks);
 }finally{await app?.close();await rm(directory,{recursive:true,force:true});}
});

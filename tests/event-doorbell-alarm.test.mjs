// EV-3 on the real AccountController (shared by the Worker object and Node): the EV-3 controller hunk of
// packages/runtime/integration-events.mjs subscribes through `eventDoorbellApp`, the account alarm rings and delivers a
// signed doorbell that the conformance fixture verifies, the subscriber reads via its cursor, and reader revocation
// plus `eventDoorbellCancel` stop further doorbells. Publishing goes through the mounted `event-bus/v1` handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateIntegrationManifest,PREFERENCES_UPDATED_EVENT} from '../packages/federation/integrations.mjs';
import {brokeringKeys} from '../packages/federation/signing.mjs';
import * as E from '../packages/runtime/integration-events.mjs';
import {eventBusResourceMethod} from '../packages/runtime/account/events.mjs';
import {EVENT_BUS_CONTRACT} from '../packages/events/index.mjs';
import {BUS_ADVANCED_EVENT,withDoorbellKick} from '../packages/events/doorbell.mjs';
import {AccountController} from '../packages/runtime/accounts.mjs';
import {SqliteMetadata,SerialGate} from '../apps/node/resources.mjs';
import {createIntegrationServer,ISSUER} from './fixtures/integration-server.mjs';
import {OWNER} from './helpers/app-engine.mjs';
import {manifest} from './event-bus-fixture.mjs';

const SUB=`${ISSUER}/entities/${OWNER}`,SECRET=Buffer.alloc(32,7).toString('base64');
function memory(){const map=new Map();let tail=Promise.resolve();return {transaction(fn){const run=tail.then(()=>fn({get:async k=>structuredClone(map.get(k)),set:async(k,v)=>{map.set(k,structuredClone(v));}}));tail=run.catch(()=>{});return run;}};}
function snapshot(host='integration.example'){
 const clientId=`https://${host}/bindle/client.json`,redirectUris=[`https://${host}/bindle/callback`],jwksUri=`https://${host}/bindle/jwks.json`;
 const r=validateIntegrationManifest({v:1,events_endpoint:`https://${host}/bindle/events`,events:[PREFERENCES_UPDATED_EVENT,BUS_ADVANCED_EVENT]},{clientId,confidential:true,redirectUris,jwksUri});assert.equal(r.status,'valid',r.reason);
 return {client:{id:clientId,name:host},snapshot:{clientId,redirectUris,authMethod:'private_key_jwt',jwksUri,thumbprints:['A'.repeat(43)],manifest:r.manifest}};
}

test('account alarm: subscribe, publish kick, fixture-verified doorbell, cursor read, revocation stops doorbells',async t=>{
 const db=new SqliteMetadata(':memory:');t.after(()=>db.close());const keys=brokeringKeys({issuer:ISSUER,secret:SECRET,metadata:memory()});let server;const sent=[];
 const egress={async send({url,body}){sent.push(body);const response=await server.fetch(url,{method:'POST',headers:{'Content-Type':E.SET_MEDIA_TYPE},body});return {status:response.status,bytes:new Uint8Array(await response.arrayBuffer())};}};
 const document=manifest(),kicks=[];let a,granted=true;
 const config={APP_ORIGIN:ISSUER,KEY_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),INTEGRATIONS_ENABLED:'true',EVENT_BUSES_ENABLED:'true',FEDERATION_SCHEMAS:JSON.stringify({[document.id]:document}),
  FEDERATION_IDENTITY_CHECK:async()=>true,IDENTITY_ACCOUNT:async owner=>owner===OWNER?{status:'active',handle:'alice'}:null,
  // The composition hunk for account/events.mjs (reported): the publish notifier kicks the integration alarm.
  EVENT_BUS_WAITER:withDoorbellKick({advance:async()=>{},revoke:async()=>{},wait:async()=>({reason:'timeout'})},async owner=>{kicks.push(owner);await a.integrationEventsKick(owner);},{store:{list:o=>db.list(o)}}),
  INTEGRATION_EVENT_PORTS:{signer:keys,egress,snapshot:async()=>({revision:'r1',values:{}}),doorbellGrant:async({epoch})=>granted&&epoch==='grant:rs-1'}};
 const bucket={put:async()=>{},get:async()=>null,delete:async()=>{}};a=new AccountController({metadata:db,gate:new SerialGate(),blobs:bucket,archives:bucket,config,sql:db.sql});await a.touch(OWNER);
 const c=await a.connectionsSystem(OWNER,{operation:'connections.connect',input:snapshot()});
 server=createIntegrationServer({clock:{now:()=>Date.now()},connections:[{iss:ISSUER,id:c.id,sub:SUB,generation:c.generation}],verifyToken:async(token,{audience})=>(await E.verifySecurityEventToken(token,{subject:SUB,keys:await keys.jwks(),issuer:ISSUER,audience,connection:({connection})=>connection===c.id})).claims});t.after(()=>server.close());
 const bus=(await a.eventBusOwner(OWNER,{operation:'events.create',input:{url:document.id}})).bus,resource=`${ISSUER}/entities/${OWNER}/buses/${bus.id}`,clientId=snapshot().client.id;
 await a.eventBusReader(OWNER,{operation:'approved',id:bus.id,input:{clientId,readSince:'rs-1'}});
 const actor={kind:'app',owner:OWNER,clientId,origin:'https://integration.example',connection:{id:c.id,generation:c.generation}};
 assert.deepEqual(await eventBusResourceMethod(a,OWNER,{contract:EVENT_BUS_CONTRACT,method:'subscribe',args:{},resource,authority:'bindle',epoch:'session-1',connection:actor.connection,clientId,grant:{fragment:document.id,digest:bus.digest,readSince:'rs-1'}}),{subscribed:true});
 const context=(method,extra={})=>({contract:EVENT_BUS_CONTRACT,method,resource,authority:'bindle',epoch:'session-1',connection:{id:c.id,generation:c.generation},clientId,grant:{fragment:document.id,digest:bus.digest,readSince:'rs-1'},...extra});
 const first=await eventBusResourceMethod(a,OWNER,context('read',{args:{}}));
 await eventBusResourceMethod(a,OWNER,context('publish',{args:{type:'created',data:{task:'t-1',title:'Secret title'}},tx:crypto.randomUUID()}));
 assert.deepEqual(kicks,[OWNER]);assert.ok(await db.getAlarm()<=Date.now()+1000,'the publish woke the alarm');
 const run=await a.integrationEventsAlarm(OWNER);assert.equal(run.rang.rung,1);assert.equal(run.delivered.acknowledged,1);
 const [bell]=(await server.snapshot()).events.filter(e=>e.type===BUS_ADVANCED_EVENT);assert.equal(bell.bus,resource);assert.equal(bell.head,1);
 assert.equal(Buffer.from(sent.at(-1).split('.')[1],'base64url').toString().includes('Secret title'),false);
 const pulled=await eventBusResourceMethod(a,OWNER,context('read',{args:{cursor:first.cursor}}));assert.deepEqual(pulled.records.map(r=>r.data.task),['t-1']);assert.equal(pulled.head,bell.head);
 // Revocation cancels immediately in the mounted reader hook; the next alarm has nothing left to deliver.
 granted=false;await a.eventBusReader(OWNER,{operation:'revoked',id:bus.id,input:{clientId}});
 await new Promise(resolve=>setTimeout(resolve,5));
 await eventBusResourceMethod(a,OWNER,context('publish',{args:{type:'created',data:{task:'t-2'}},tx:crypto.randomUUID()}));
 const after=await a.integrationEventsAlarm(OWNER);assert.equal(after.rang.cancelled,0);assert.equal((await server.snapshot()).events.filter(e=>e.type===BUS_ADVANCED_EVENT).length,1);
 assert.deepEqual(await a.eventDoorbellCancel(OWNER,{clientId}),{cancelled:0});
 await assert.rejects(a.eventDoorbellApp(OWNER,{method:'read',id:bus.id,actor}),{code:'unsupported_method'});
});

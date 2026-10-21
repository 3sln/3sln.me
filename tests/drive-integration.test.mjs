import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestEngine,OWNER,OTHER} from './helpers/app-engine.mjs';
import {AppConnections,builtInManifestValid} from '../packages/apps/connections.mjs';
import * as C from '../packages/app/domains/connections.mjs';
import {validateSchema,validateValue} from '../packages/federation/schema.mjs';
import {GoogleDriveService} from '../packages/storage/google-drive.mjs';
import {GOOGLE_DRIVE_INTEGRATION,GOOGLE_DRIVE_SETUP_FRAGMENT,GOOGLE_DRIVE_DISCLOSURE,DriveIntegrationSetup} from '../packages/storage/google-drive-integration.mjs';
const owner={kind:'owner',owner:OWNER},system={kind:'system',owner:OWNER},ORIGIN='https://3sln.example';
async function fixture(t,{config={}}={}){
 const f=await createTestEngine();t.after(()=>f.dispose());await f.metadata.put('owner',OWNER);
 const connections=new AppConnections({metadata:f.metadata,origin:ORIGIN,clock:f.clock.now,builtins:{'google-drive':GOOGLE_DRIVE_INTEGRATION}}),deployment={INTEGRATIONS_ENABLED:true,APP_ORIGIN:ORIGIN,...config};
 const h=await createTestEngine({providers:{config:deployment,accountStore:f.metadata,connections:C.connectionsProvider({connections,enabled:C.integrationsEnabled(deployment),account:async()=>({status:'active'})})}});t.after(()=>h.dispose());
 return {...f,connections,config:deployment,query:(actor=owner,input)=>h.read(new DriveIntegrationSetup({actor,...input===undefined?{}:{input}})),run:(Operation,input,actor=owner)=>h.perform(new Operation({actor,input}))};
}
test('Drive has one provider-authored manifest, a valid bounded setup fragment and no network endpoints/credentials',()=>{
 assert.equal(builtInManifestValid(GOOGLE_DRIVE_INTEGRATION.manifest),true);assert.deepEqual(validateSchema(GOOGLE_DRIVE_SETUP_FRAGMENT,GOOGLE_DRIVE_SETUP_FRAGMENT.id),GOOGLE_DRIVE_SETUP_FRAGMENT);
 assert.deepEqual(Object.keys(GOOGLE_DRIVE_INTEGRATION.manifest).sort(),['resources','setup','v']);assert.deepEqual(GOOGLE_DRIVE_INTEGRATION.manifest.setup.fragments[0].fields,['name']);
 assert.deepEqual(validateValue(GOOGLE_DRIVE_SETUP_FRAGMENT.fields.name,'My archive'),['My archive']);for(const value of ['', 'a'.repeat(101),'bad\nname'])assert.throws(()=>validateValue(GOOGLE_DRIVE_SETUP_FRAGMENT.fields.name,value));
 assert.deepEqual(GOOGLE_DRIVE_DISCLOSURE.disconnect,{localOnly:true,providerRevoked:false,remoteDataDeleted:false});assert.equal(GOOGLE_DRIVE_DISCLOSURE.conditionalAuthority,'bindle-host');assert.ok(Object.isFrozen(GOOGLE_DRIVE_INTEGRATION.manifest.setup.fragments));
});
test('Drive definition is behind INTEGRATIONS_ENABLED, owner-scoped, and setup reads create nothing',async t=>{
 for(const INTEGRATIONS_ENABLED of [undefined,false,'false']){const f=await fixture(t,{config:{INTEGRATIONS_ENABLED}});await assert.rejects(f.query(),{code:'not_found'});}
 const f=await fixture(t);const setup=await f.query();assert.equal(setup.upstreamConfigured,false);assert.deepEqual(setup.connections,[]);assert.equal((await f.metadata.list({prefix:'resource/'})).size,0);
 await assert.rejects(f.query({kind:'owner',owner:OTHER}),{code:'forbidden'});await assert.rejects(f.query(system),{code:'unauthorized'});await assert.rejects(f.query(owner,{name:'Unapproved'}),{code:'invalid_args'});
});
test('X4 owner approval creates one configuring connection; setup completion and severance use the same lifecycle',async t=>{
 const f=await fixture(t);await assert.rejects(f.run(C.ConnectBuiltIn,{integration:'google-drive'},system),{code:'forbidden'});
 const connection=await f.run(C.ConnectBuiltIn,{integration:'google-drive'});assert.equal(connection.state,'configuring');assert.equal(connection.integration.kind,'built-in');assert.equal(connection.integration.builtin,'google-drive');
 assert.equal((await f.connections.slots(OWNER)).every(s=>s.occupants.length===0),true);const before=await f.query();assert.deepEqual(before.connections,[{id:connection.id,state:'configuring',generation:1,configured:false}]);
 await f.run(C.ConnectionConfigured,{connection:connection.id,expectedGeneration:connection.generation,configured:true},system);assert.equal((await f.query()).connections[0].state,'active');
 const again=await f.run(C.ConnectBuiltIn,{integration:'google-drive'});assert.equal(again.id,connection.id);assert.equal((await f.query()).connections.length,1);
 const paused=await f.run(C.SuspendConnection,{connection:connection.id});assert.equal((await f.query()).connections[0].state,'suspended');await f.run(C.ResumeConnection,{connection:connection.id,expectedGeneration:paused.generation});await f.run(C.DisconnectConnection,{connection:connection.id});assert.equal((await f.query()).connections[0].state,'disconnected');
});
test('configured keys report configuration only, never a verified upstream resource or delivery capability',async t=>{
 const f=await fixture(t,{config:{GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'private-key',KEY_ENCRYPTION_KEY:'fixture'}});const setup=await f.query();assert.equal(setup.upstreamConfigured,true);assert.deepEqual(setup.connections,[]);assert.equal(JSON.stringify(setup).includes('private-key'),false);
 const original=GOOGLE_DRIVE_INTEGRATION.name;setup.definition.name='changed';assert.equal(GOOGLE_DRIVE_INTEGRATION.name,original);
});
test('unified connection disconnect leaves existing Drive resources, OAuth state and connector behavior intact',async t=>{
 const f=await fixture(t);const drive=new GoogleDriveService({metadata:f.metadata,config:f.config,fetcher:()=>{throw Error('No network allowed');}}),caps=drive.capabilities();
 const r={id:crypto.randomUUID(),owner:OWNER,provider:'google-drive',status:'connected',generation:crypto.randomUUID(),secret:{ciphertext:'existing-sealed-upstream-credential'},capabilities:caps};await f.metadata.put('resource/'+r.id,r);await f.metadata.put('drive/oauth/session',{sealed:'existing-state'});
 const cnx=await f.run(C.ConnectBuiltIn,{integration:'google-drive'});await f.run(C.DisconnectConnection,{connection:cnx.id});assert.deepEqual(await f.metadata.get('resource/'+r.id),r);assert.deepEqual(await f.metadata.get('drive/oauth/session'),{sealed:'existing-state'});assert.deepEqual(drive.capabilities(),caps);assert.equal(caps.physicalRetention,true);assert.equal(caps.namespace,'provider-managed-logical-keys');
});

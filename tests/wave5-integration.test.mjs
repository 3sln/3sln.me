import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nodeResources} from '../apps/node/resources.mjs';
import {brokeredProvider,OWNER,FRAGMENT,MODEL,SUBJECT} from './fixtures/brokered-provider.mjs';
import {brokeredResourceId,account as x8} from '../packages/federation/introspection.mjs';
import {FederationController,federationRemote} from '../packages/federation/runtime.mjs';
import {stages} from '../packages/runtime/routes/connections.mjs';
import {GOOGLE_DRIVE_SETUP_FRAGMENT} from '../packages/storage/google-drive-integration.mjs';
import {digest,canonical} from '../packages/messaging/store.mjs';

async function prepared(t){const f=await brokeredProvider(t,{introspection:true}),r=await f.register('https://models.example/r/fast'),id=brokeredResourceId(SUBJECT,r.id);await f.configure({theme:'dark',model:[id],store:[]});const token=await f.authorize({resources:{model:[id],store:[]}});return {...f,r,id,token};}
test('X8 adapter composition declares only mounted capabilities and moves the provisional key URL',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'bindle-wave5-')),resources=await nodeResources({directory,config:{APP_ORIGIN:'https://provider.example',FEDERATION_ENABLED:'true',INTEGRATIONS_ENABLED:'true',BROKERING_ENABLED:'true',KEY_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),FEDERATION_CLIENTS:JSON.stringify([{id:'https://app.example/client',name:'App',origin:'https://app.example',redirectUris:['https://app.example/callback']}])}});t.after(async()=>{resources.close();await rm(directory,{recursive:true,force:true});});
 const config=resources.integrationConfig,manifest=await resources.federation.manifest();assert.equal(config.BROKERED_INTROSPECTION_MOUNTED,true);assert.equal(config.INTEGRATION_EVENT_PORTS.snapshot.available,true);assert.equal(typeof config.BROKERING_CONSUMER_MINT,'function');assert.equal(typeof config.BROKERED_INTROSPECTION,'function');assert.equal(manifest.features['brokered-resources.v1'].introspection_endpoint,'https://provider.example/oauth/brokering/introspect');
 const {handleFederation}=await import('../packages/federation/http.mjs');const response=await handleFederation(new Request('https://provider.example/.well-known/bindle/manifest.json'),{issuer:'https://provider.example',controller:resources.federation,brokering:resources.brokering});const wire=await response.json();assert.equal(wire.brokering_jwks_uri,undefined);assert.equal(wire.features['brokered-resources.v1'].jwks_uri,'https://provider.example/oauth/brokering/jwks');
 assert.equal((await config.BROKERED_INTROSPECTION(new Request('https://provider.example/oauth/brokering/introspect'))).status,405);
});

test('X8-R2: federation revocation journals before delivery, retries after failure and account enqueue deduplicates',async t=>{
 const f=await prepared(t);await f.read(f.token);let down=true,calls=0;
 const account={metadata:f.metadata,config:{APP_ORIGIN:'https://3sln.example',INTEGRATIONS_ENABLED:'true',BROKERING_ENABLED:'true'},integrationEventsKick:async()=>{}};
 f.brokering.event=async input=>{calls++;if(down)throw Error('offline');return x8.methods.brokeredFederationEvent.call(account,OWNER,input);};
 await f.s.revoke(f.owner,f.token.grants[0]);assert.equal((await f.s.drainBrokeredEvents()).pending,true);
 const rows=await f.s.store.transaction(tx=>tx.list('federation/brokered-event/'));assert.equal(rows.length,1);const event=rows[0].value;
 down=false;await f.s.drainBrokeredEvents();assert.equal((await f.s.store.transaction(tx=>tx.list('federation/brokered-event/'))).length,0);assert.ok(calls>=2);
 const before=(await f.metadata.list({prefix:'integration-events/row/'})).size;assert.ok(before>0);assert.deepEqual(await x8.methods.brokeredFederationEvent.call(account,OWNER,event),{duplicate:true});assert.equal((await f.metadata.list({prefix:'integration-events/row/'})).size,before);
});

test('X8-R2: field removal invalidates same-second tokens permanently across reapproval',async t=>{
 const f=await prepared(t),entry=(await f.read(f.token)).values.model[0],claims=JSON.parse(Buffer.from(entry.token.split('.')[1],'base64url'));
 const input={clientId:claims.client_id,resourceId:f.id,fragment:FRAGMENT,field:'model',methods:claims.bindle.methods,jti:claims.jti,iat:claims.iat};assert.equal(await f.s.brokeredGrantLive(input),true);
 await f.configure({theme:'dark',model:[],store:[]});await f.configure({theme:'dark',model:[f.id],store:[]});await f.authorize({resources:{model:[f.id],store:[]}});assert.equal(await f.s.brokeredGrantLive(input),false);assert.ok((await f.s.store.transaction(tx=>tx.list('federation/brokered-event/'))).length);
});

test('X8-R2: an unrelated value change keeps brokered tokens live and journals nothing',async t=>{
 const f=await prepared(t),entry=(await f.read(f.token)).values.model[0],claims=JSON.parse(Buffer.from(entry.token.split('.')[1],'base64url'));
 await f.configure({theme:'light',model:[f.id],store:[]});assert.equal(await f.s.brokeredGrantLive({clientId:claims.client_id,resourceId:f.id,fragment:FRAGMENT,field:'model',methods:claims.bindle.methods,jti:claims.jti,iat:claims.iat}),true);
 assert.equal((await f.s.store.transaction(tx=>tx.list('federation/brokered-event/'))).length,0);
});

test('X11 owner adapters forward only trusted auth time, gate flags, validate setup pins and use the client directory',async()=>{
 const fragment=GOOGLE_DRIVE_SETUP_FRAGMENT.id,c={id:'c',generation:1,state:'configuring',clientId:'https://app.example/client',integration:{manifest:{v:1,setup:{fragments:[{fragment,required:true,fields:['name']}]}}}},calls=[];
 let saved=null;const object={connectionsOwner:async(...args)=>{calls.push(args);return {connections:[c]};},admitWork:async()=>{},connectionsSetupComplete:async(...args)=>calls.push(args)},env={APP_ORIGIN:'https://provider.example',INTEGRATIONS_ENABLED:'true',FEDERATION_AUTHORITY:{directory:{enabled:true,resolve:async id=>({id,integration:{status:'valid'},initiateLoginUri:'https://app.example/start'})},preferences:async()=>({preferences:saved?[{fragment,revision:'r1',values:saved.values}]:[]}),configure:async(_,input)=>{saved=input;return {revision:'r1'};}}};
 const route=(path,input,patch={})=>stages.owner({request:new Request(env.APP_ORIGIN+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),path,env,object,id:OWNER,context:{sessionToken:'owner'},owner:{authTime:123},...patch});
 assert.equal(await route('/api/connections/owner',{operation:'connections.list'},{env:{...env,INTEGRATIONS_ENABLED:'false'}}),undefined);
 await route('/api/connections/owner',{operation:'connections.occupy',authTime:999});assert.deepEqual(calls.at(-1)[2],{authTime:123});
 const setup=await(await route('/api/connections/setup',{connection:'c',generation:1})).json();assert.equal(setup.fragments[0].digest,await digest(crypto,canonical(GOOGLE_DRIVE_SETUP_FRAGMENT)));
 const save={connection:'c',generation:1,action:'save',fragment,digest:setup.fragments[0].digest,expectedRevision:null,values:{name:'Folder'}};
 await assert.rejects(route('/api/connections/setup',{...save,digest:'forged'}),{code:'stale_consent'});await route('/api/connections/setup',save);assert.deepEqual(saved.values,{name:'Folder'});assert.equal(calls.at(-1)[1].configured,true);
 const external=await(await route('/api/connections/client-metadata',{clientId:'https://app.example/client'})).json();assert.equal(external.initiate_login_uri,'https://app.example/start');
});

test('W5-S1: the pinned private_key_jwt governs the token endpoint; downgraded live metadata and fenced pins are refused',async()=>{
 const {federationAuthority}=await import('../packages/runtime/federation.mjs'),owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',clientId='https://int.example/bindle/client.json',jwksUri='https://int.example/bindle/jwks.json';
 let pin={clientId,jwksUri,thumbprints:['A'.repeat(43)],serving:false,tokenAuth:true},live={id:clientId,redirectUris:['https://int.example/cb'],authMethod:'private_key_jwt',jwksUri};const seen=[];
 const directory={enabled:true,integrations:true,isMetadataId:()=>true,assertAllowed:async()=>{},resolve:async()=>structuredClone(live),resolveKeys:async()=>{keyFetches++;return {keys:[]};}};let keyFetches=0;
 const auth=federationAuthority({config:{APP_ORIGIN:'https://3sln.example',KEY_ENCRYPTION_KEY:'x'.repeat(64),FEDERATION_ENABLED:'true',INTEGRATIONS_ENABLED:'true'},repository:{get:async()=>({status:'active'})},directory,shard:()=>({integrationClientAuth:async()=>pin,exchange:async input=>{seen.push(input);return {ok:true};},refresh:async input=>{seen.push(input);return {ok:true};}})});
 const exchange=()=>auth.exchange({code:`${owner}.${'c'.repeat(43)}`,verifier:'v'.repeat(43),clientId,redirectUri:'https://int.example/cb'}),refresh=()=>auth.refresh({refreshToken:`${owner}.${'r'.repeat(43)}`,clientId});
 await assert.rejects(exchange(),{code:'invalid_client'},'no assertion');
 await assert.rejects(exchange().then(()=>{},()=>auth.exchange({code:`${owner}.${'c'.repeat(43)}`,verifier:'v'.repeat(43),clientId,redirectUri:'https://int.example/cb',clientAssertionType:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',clientAssertion:'a.b.c'})),{code:'invalid_client'},'a configuring pin still authenticates, and a bad assertion fails');assert.equal(keyFetches,1,'only the asserted call reaches pinned key verification');
 live={id:clientId,redirectUris:['https://int.example/cb']};await assert.rejects(exchange(),{code:'invalid_client'},'live metadata downgraded to none');await assert.rejects(refresh(),{code:'invalid_client'});
 live={id:clientId,redirectUris:['https://int.example/cb'],authMethod:'private_key_jwt',jwksUri:'https://int.example/bindle/other.json'};await assert.rejects(exchange(),{code:'invalid_client'},'a changed jwks_uri awaits review');
 live={id:clientId,redirectUris:['https://int.example/cb'],authMethod:'private_key_jwt',jwksUri};pin={...pin,tokenAuth:false};await assert.rejects(exchange(),{code:'invalid_client'},'suspended or fenced');
 pin=null;live={id:clientId,redirectUris:['https://int.example/cb']};assert.deepEqual(await exchange(),{ok:true},'plain public clients are unaffected');assert.equal(seen.length,1);
});

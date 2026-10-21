// EXT-X8 preferences/v2 (packages/federation/service.mjs projection, mint and confirm paths) over a real federation
// service and the real X7/X8 account engines: the uniform reference shape with minted brokered credentials, v1 left
// unchanged (brokered occupants withheld), AMD-C3 mixed approval, attenuation by grant, severance reported as
// `unavailable`, the grant-revocation race, integration `seq`, the X6 snapshot port, the federation half of
// introspection, the issuer gateway refusing brokered tokens and references, and the feature declaration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash,randomUUID} from 'node:crypto';
import {createAppEngine,perform} from '../packages/app/engine.mjs';
import {memoryAudit} from '../packages/app/providers.mjs';
import {AppConnections} from '../packages/apps/connections.mjs';
import * as C from '../packages/app/domains/connections.mjs';
import * as B from '../packages/federation/brokered.mjs';
import * as X from '../packages/federation/introspection.mjs';
import {FederationService,MemoryFederationStore,PREFERENCES} from '../packages/federation/index.mjs';
import {PREFERENCES_V2} from '../packages/federation/service.mjs';
import {DiscoveryClient,DiscoveryBudget,createIntegrationEgress} from '../packages/federation/resource-discovery.mjs';
import {validateIntegrationManifest} from '../packages/federation/integrations.mjs';
import {brokeringKeys,mintAccessToken,verifyAccessToken} from '../packages/federation/signing.mjs';
import {federationDeclarations} from '../packages/runtime/federation.mjs';
import {SqliteMetadata} from '../apps/node/resources.mjs';
import {fakeClock} from './helpers/chaos.mjs';

const OWNER='cccccccc-cccc-4ccc-8ccc-cccccccccccc',ISSUER='https://3sln.example',SUBJECT=`${ISSUER}/entities/${OWNER}`;
const MODEL='https://spec.bindle.example/contracts/decision-model/v1',STORE='https://3sln.me/artefacts/contracts/object-storage/v1';
const FRAGMENT='https://notes.example/preferences/models/v1',APP='https://notes.example/client.json',REDIRECT='https://notes.example/callback',STORE_ID=`${ISSUER}/resources/files`;
const PINS=X.contractPins({[MODEL]:{methods:{decide:{effect:'read'},train:{effect:'write'}}}});
const schema={id:FRAGMENT,title:'Models',description:'Model settings',publisher:'https://notes.example',fields:{theme:{title:'Theme',type:'enum',values:['dark','light']},model:{title:'Models',type:'resource',cardinality:{min:0,max:4},contracts:[MODEL]},store:{title:'Files',type:'resource',cardinality:{min:0,max:4},contracts:[STORE]}}};
const code=c=>e=>{assert.equal(e.code,c,`expected ${c}, got ${e.code}: ${e.message}`);return true;};
const pkce=v=>createHash('sha256').update(v).digest('base64url');
function memory(){const map=new Map();let tail=Promise.resolve();return {transaction(fn){const run=tail.then(()=>fn({get:async k=>structuredClone(map.get(k)),set:async(k,v)=>{map.set(k,structuredClone(v));},delete:async k=>{map.delete(k);},list:async()=>[]}));tail=run.catch(()=>{});return run;}};}
const keys=brokeringKeys({issuer:ISSUER,secret:Buffer.alloc(32,9).toString('base64'),metadata:memory()});

/** The owner's account (X4 connection, X7 records, X8 tokens) and federation shard, wired as the adapters would. */
async function fixture(t,{connections=false,seq,introspection=false,refreshEnabled=false}={}){
 const metadata=new SqliteMetadata(':memory:');await metadata.put('owner',OWNER);t.after(()=>metadata.close());
 const clock=fakeClock(Date.now()),random={uuid:()=>crypto.randomUUID(),bytes:k=>crypto.getRandomValues(new Uint8Array(k))},audit=memoryAudit({clock});let n=0;
 const cx=createAppEngine({providers:{clock,random,audit,connections:C.connectionsProvider({connections:new AppConnections({metadata,origin:ISSUER,clock:clock.now,uuid:()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`}),enabled:true,account:async()=>({status:'active'})})}});
 const items=host=>[{id:`https://${host}/r/fast`,label:'Fast model',contracts:[MODEL]},{id:`https://${host}/r/slow`,label:'Slow model',contracts:[MODEL]}];
 const fetcher=async(url,init)=>{const body=JSON.parse(init.body),host=new URL(url).hostname;return Response.json({v:1,items:items(host).filter(i=>!body.ids||body.ids.includes(i.id)).map(i=>({container:false,facets_applied:[],...i})),cursor:null});};
 const discovery=new DiscoveryClient({issuer:ISSUER,mint:claims=>mintAccessToken(keys,claims,{clock:clock.now}),egress:createIntegrationEgress({fetcher,resolve:async()=>['93.184.216.34'],publicRouting:true}),budget:new DiscoveryBudget({budgets:{connectionPerMinute:1000,integrationPerMinute:1000}}),clock:clock.now});
 const x7=createAppEngine({providers:{clock,random,audit,brokeredResources:B.brokeredResourcesProvider({store:metadata,discovery,issuer:ISSUER,integrations:true,brokering:true,clock:clock.now})}});
 const x8=X.brokeredTokensEngine({store:metadata,issuer:ISSUER,integrations:true,brokering:true,mint:claims=>mintAccessToken(keys,claims,{clock:clock.now}),pins:PINS,introspection,clock,random,audit});
 const system={kind:'system',owner:OWNER},ownerActor={kind:'owner',owner:OWNER,authTime:clock.now()},q=(Operation,input)=>X.runBrokered(x8,Operation,{actor:system,...input===undefined?{}:{input}});
 const snap=host=>{const clientId=`https://${host}/bindle/client.json`,r=validateIntegrationManifest({v:1,resources:{rpc_endpoint:`https://${host}/bindle/rpc`,discovery_endpoint:`https://${host}/bindle/resources`,contracts:[MODEL]}},{clientId,confidential:true,redirectUris:[`https://${host}/bindle/callback`],jwksUri:`https://${host}/bindle/jwks.json`});return {client:{id:clientId,name:host},snapshot:{clientId,redirectUris:[`https://${host}/bindle/callback`],authMethod:'private_key_jwt',jwksUri:`https://${host}/bindle/jwks.json`,thumbprints:['A'.repeat(43)],manifest:r.manifest}};};
 const integration=await perform(cx,new C.ConnectIntegration({actor:system,input:snap('models.example')}));
 const register=resource=>perform(x7,new B.RegisterBrokeredRecord({actor:ownerActor,input:{connection:integration.id,resource,binding:{fragment:FRAGMENT,field:'model'},consumer:{clientId:APP},contracts:[MODEL]}}));
 const minted=[],brokering={enabled:true,mint:async input=>{const out=await q(X.MintBrokeredToken,input);minted.push(out);return out;},...seq?{seq}:{}};
 const owner={session:'owner'};let now=clock.now();
 const s=new FederationService({issuer:ISSUER,routingKey:OWNER,refreshEnabled,crypto:webcrypto,clock:()=>now,store:new MemoryFederationStore(),clients:[{id:APP,name:'Notes',origin:'https://notes.example',redirectUris:[REDIRECT]}],schemaHosts:['notes.example'],schemaFetcher:async()=>structuredClone(schema),
  authenticateOwner:async a=>{if(a!==owner)throw Object.assign(new Error('unauthorized'),{code:'unauthorized'});return {subject:SUBJECT};},
  resourceProvider:async()=>[{id:STORE_ID,label:'Files',provider:'bindle',contracts:{[STORE]:['get','put']}},...await q(X.BrokeredDescriptors)],brokering});
 const bindings=new Map();
 if(connections)s.connections={binding:async client=>({id:client,generation:bindings.get(client)?.generation??0}),connect:async(client,expected)=>{const prior=bindings.get(client.id);if((prior?.generation??0)!==expected.generation)throw Object.assign(new Error('stale'),{code:'consent_stale'});const record={id:client.id,generation:(prior?.generation??0)+1,active:true};bindings.set(client.id,record);return record;},check:async(connection,client)=>{const record=bindings.get(client);return record?.active===true&&record.generation===connection.generation;}};
 const configure=async values=>{const current=(await s.preferences(owner)).preferences.find(p=>p.fragment===FRAGMENT);return s.configure(owner,{fragment:FRAGMENT,values,expectedRevision:current?.revision??null});};
 const authorize=async({fields=['theme','model','store'],resources,methods={model:{[MODEL]:['decide']},store:{[STORE]:['get']}},requested={model:{[MODEL]:['decide','train']},store:{[STORE]:['get']}}})=>{
  const verifier='v'.repeat(43),{requestId}=await s.beginAuthorization({clientId:APP,redirectUri:REDIRECT,challenge:pkce(verifier),challengeMethod:'S256',state:'st',requests:[{fragment:FRAGMENT,required:true,purpose:'Pick models',fields,methods:requested}]});
  const view=await s.inspect(requestId,owner),decision=await s.approve(owner,{requestId,approved:[{fragment:FRAGMENT,revision:view.requests[0].revision,fields,resources,methods}]});
  const url=new URL(decision.redirectUri);return s.exchange({code:url.searchParams.get('code'),verifier,clientId:APP,redirectUri:REDIRECT});};
 const read=(token,contract=PREFERENCES_V2)=>s.rpc(token.access_token??token,{version:'0',tx:randomUUID(),resource:'@preferences',contract,method:'read',args:{fragment:FRAGMENT}}).then(r=>r.result);
 return {s,owner,clock,metadata,cx,x7,x8,q,integration,register,configure,authorize,read,minted,brokering,bindings,advance:ms=>{now+=ms;clock.advance(ms);}};
}

test('preferences/v2 projects uniform references: minted brokered credentials, issuer child tokens, attenuated methods',async t=>{
 const f=await fixture(t),record=await f.register('https://models.example/r/fast'),id=X.brokeredResourceId(SUBJECT,record.id);
 await f.configure({theme:'dark',model:[id],store:[STORE_ID]});const token=await f.authorize({resources:{model:[id],store:[STORE_ID]}});
 const result=await f.read(token);assert.equal(result.requiresConsent,undefined);assert.equal(result.values.theme,'dark');assert.equal(result.seq,undefined,'not an integration reader');
 const [model]=result.values.model,[store]=result.values.store;
 assert.deepEqual(Object.keys(model).sort(),['broker','contracts','expires_at','id','label','methods','status','token','token_type']);
 assert.equal(model.status,'available');assert.equal(model.token_type,'Bearer');assert.deepEqual(model.methods,{[MODEL]:['decide']});assert.deepEqual(model.contracts,[MODEL]);
 assert.deepEqual(model.broker,{endpoint:'https://models.example/bindle/rpc',origin:'https://models.example',resource:'https://models.example/r/fast'});
 assert.ok(model.id.startsWith(`${ISSUER}/resources/scoped/`)&&!model.id.includes(record.id)&&!model.id.includes('models.example'),'opaque provider reference');
 const {claims}=await verifyAccessToken(model.token,{keys:await keys.jwks(),issuer:ISSUER,audience:model.broker.endpoint,purposes:['invoke'],now:f.clock.now()});
 assert.equal(claims.client_id,APP);assert.equal(claims.exp,model.expires_at);assert.ok(claims.exp-claims.iat<=300);assert.equal(claims.bindle.grant,record.assignments[0].grant);
 assert.deepEqual(Object.keys(store).sort(),['contracts','expires_at','id','label','status','token','token_type']);assert.equal(store.status,'available');assert.deepEqual(store.contracts,[STORE]);
 const object=await f.s.rpc(store.token,{version:'0',tx:randomUUID(),resource:store.id,contract:'https://3sln.me/artefacts/contracts/resource-descriptor/v1',method:'describe',args:{}});assert.deepEqual(object.result.contracts,{[STORE]:['get']},'the issuer child token is the v1 attenuation');
 // Write-capable `train` is neither approvable nor mintable without live introspection (AMD-C8/C10).
 await assert.rejects(f.authorize({resources:{model:[id],store:[STORE_ID]},methods:{model:{[MODEL]:['decide','train']},store:{[STORE]:['get']}}}),code('invalid_grant'));
 const g=await fixture(t,{introspection:true}),r2=await g.register('https://models.example/r/fast'),id2=X.brokeredResourceId(SUBJECT,r2.id);await g.configure({theme:'dark',model:[id2],store:[STORE_ID]});
 const narrow=await g.authorize({resources:{model:[id2],store:[STORE_ID]},methods:{model:{[MODEL]:['train']},store:{[STORE]:['get']}}});
 const [only]=(await g.read(narrow)).values.model;assert.deepEqual(only.methods,{[MODEL]:['train']},'the grant attenuates the token');
 assert.deepEqual((await verifyAccessToken(only.token,{keys:await keys.jwks(),issuer:ISSUER,audience:only.broker.endpoint,purposes:['invoke'],now:g.clock.now()})).claims.bindle.methods,{[MODEL]:['train']});
});

test('preferences v1 is unchanged by the brokering port; brokered occupants are withheld and listed in requiresConsent',async t=>{
 const f=await fixture(t),record=await f.register('https://models.example/r/fast'),id=X.brokeredResourceId(SUBJECT,record.id);
 await f.configure({theme:'dark',model:[id],store:[STORE_ID]});const token=await f.authorize({resources:{model:[id],store:[STORE_ID]}});
 const v1=await f.read(token,PREFERENCES);assert.deepEqual(v1.requiresConsent,['model']);assert.equal(v1.values.model,undefined);
 assert.deepEqual(Object.keys(v1.values.store[0]).sort(),['contracts','id','token'],'v1 keeps its exact shape');
 const port=f.s.brokering;f.s.brokering=null;const without=await f.read(token,PREFERENCES);f.s.brokering=port;
 assert.deepEqual(without,v1,'identical with and without the X8 port');
 assert.equal(f.minted.length,0,'v1 never mints');
 f.s.brokering=null;await assert.rejects(f.read(token),code('forbidden'),'v2 is not served without the brokering port');f.s.brokering=port;
});

test('AMD-C3: approved members stay in owner order, unapproved additions are omitted and reported; severance reads unavailable',async t=>{
 const f=await fixture(t),fast=await f.register('https://models.example/r/fast'),slow=await f.register('https://models.example/r/slow');
 const a=X.brokeredResourceId(SUBJECT,fast.id),b=X.brokeredResourceId(SUBJECT,slow.id);
 await f.configure({theme:'dark',model:[a],store:[STORE_ID]});const token=await f.authorize({resources:{model:[a],store:[STORE_ID]}});
 await f.configure({theme:'dark',model:[b,a],store:[STORE_ID]});
 const mixed=await f.read(token);assert.deepEqual(mixed.requiresConsent,['model']);assert.equal(mixed.values.model.length,1);assert.equal(mixed.values.model[0].broker.resource,'https://models.example/r/fast');
 assert.equal((await f.read(token,PREFERENCES)).values.model,undefined,'v1 still withholds the whole field');
 await perform(f.x7,new B.UnassignBrokeredRecord({actor:{kind:'owner',owner:OWNER},input:{record:fast.id,grant:fast.assignments[0].grant}}));
 const severed=(await f.read(token)).values.model[0];assert.equal(severed.status,'unavailable');assert.equal(severed.token,undefined);assert.equal(severed.expires_at,undefined);
});

test('a grant revoked while minting discards the answer; the issuer gateway refuses brokered tokens and references',async t=>{
 const f=await fixture(t),record=await f.register('https://models.example/r/fast'),id=X.brokeredResourceId(SUBJECT,record.id);
 await f.configure({theme:'dark',model:[id],store:[STORE_ID]});const token=await f.authorize({resources:{model:[id],store:[STORE_ID]}});
 const minted=(await f.read(token)).values.model[0];
 await assert.rejects(f.s.rpc(minted.token,{version:'0',tx:randomUUID(),resource:'@preferences',contract:PREFERENCES_V2,method:'read',args:{fragment:FRAGMENT}}),code('unauthorized'),'provider-minted JWTs are never issuer credentials');
 for(const resource of [id,minted.id])await assert.rejects(f.s.rpc(token.access_token,{version:'0',tx:randomUUID(),resource,contract:MODEL,method:'decide',args:{}}),code('forbidden'),'the issuer never invokes a brokered resource');
 await assert.rejects(f.s.rpc(token.access_token,{version:'0',tx:randomUUID(),resource:'@preferences',contract:PREFERENCES_V2,method:'write',args:{fragment:FRAGMENT}}),code('unsupported_method'));
 const port=f.brokering.mint,during=async change=>{f.s.brokering.mint=async input=>{const out=await port(input);await change();return out;};try{return await f.read(token);}finally{f.s.brokering.mint=port;}};
 await assert.rejects(during(()=>f.configure({theme:'light',model:[id],store:[STORE_ID]})),code('temporarily_unavailable'),'a token minted across a value change is never released');
 await assert.rejects(during(()=>f.s.revoke(f.owner,token.grants[0])),code('unauthorized'),'nor one minted across the revocation of its grant');
 await assert.rejects(f.read(token),code('unauthorized'));
});

test('integration readers get seq; the X6 snapshot port strips credentials, follows the grant and never syncs or mints',async t=>{
 const f=await fixture(t,{connections:true,seq:async ({connection})=>connection===APP?7:null}),record=await f.register('https://models.example/r/fast'),id=X.brokeredResourceId(SUBJECT,record.id);
 await f.configure({theme:'light',model:[id],store:[STORE_ID]});const token=await f.authorize({resources:{model:[id],store:[STORE_ID]}});
 const read=await f.read(token);assert.equal(read.seq,7);
 const generation=f.bindings.get(APP).generation,port=X.preferencesSnapshotPort(owner=>{assert.equal(owner,OWNER);return f.s;});const before=f.minted.length;
 const snapshot=await port({owner:OWNER,connection:APP,clientId:APP,generation,fragment:FRAGMENT});
 assert.equal(snapshot.revision,read.revision);assert.equal(f.minted.length,before,'snapshots never mint');
 assert.equal(JSON.stringify(snapshot.values).match(/"(token|token_type|expires_at)"/),null);
 assert.deepEqual(snapshot.values.model[0],{id:read.values.model[0].id,label:'Fast model',status:'available',contracts:[MODEL],methods:{[MODEL]:['decide']},broker:read.values.model[0].broker});
 assert.deepEqual(snapshot.values.store[0],{id:read.values.store[0].id,label:'Files',status:'available',contracts:[STORE]});assert.equal(snapshot.values.theme,'light');
 assert.deepEqual(await port({owner:OWNER,connection:APP,clientId:APP,generation:generation+1,fragment:FRAGMENT}),{revision:read.revision,values:null},'another generation');
 assert.deepEqual((await port({owner:OWNER,connection:'other',clientId:APP,generation,fragment:FRAGMENT})).values,null);
 await f.s.revoke(f.owner,token.grants[0]);assert.equal((await port({owner:OWNER,connection:APP,clientId:APP,generation,fragment:FRAGMENT})).values,null,'values null once the grant is revoked');
 await assert.rejects(port({connection:APP}),code('snapshot_unavailable'));
});

test('introspection, federation half: live grant, assignment, approval, consumer session and methods (X8-R2, X8-R3)',async t=>{
 const f=await fixture(t,{refreshEnabled:true}),record=await f.register('https://models.example/r/fast'),id=X.brokeredResourceId(SUBJECT,record.id);
 await f.configure({theme:'dark',model:[id],store:[STORE_ID]});const token=await f.authorize({resources:{model:[id],store:[STORE_ID]}});
 const claimsOf=async session=>(await verifyAccessToken((await f.read(session)).values.model[0].token,{keys:await keys.jwks(),issuer:ISSUER,audience:'https://models.example/bindle/rpc',purposes:['invoke'],now:f.clock.now()})).claims;
 let c=await claimsOf(token);
 const live=input=>f.s.brokeredGrantLive({clientId:APP,resourceId:id,fragment:FRAGMENT,field:'model',methods:{[MODEL]:['decide']},jti:c.jti,iat:c.iat,...input});
 assert.equal(await live(),true);assert.equal(await live({methods:{[MODEL]:['train']}}),false,'not granted');assert.equal(await live({methods:{[MODEL]:['delete']}}),false);assert.equal(await live({field:'store'}),false);assert.equal(await live({clientId:'https://other.example/client.json'}),false);
 assert.equal(await live({jti:'never-issued-by-this-shard'}),false,'only tokens this shard released');
 assert.equal(await live({resourceId:STORE_ID,field:'store',methods:{[STORE]:['get']}}),false,'issuer-hosted resources are never brokered');assert.equal(await live({extra:1}),false);
 await f.configure({theme:'dark',model:[],store:[STORE_ID]});assert.equal(await live(),false,'removed from the field');
 await f.configure({theme:'dark',model:[id],store:[STORE_ID]});assert.equal(await live(),false,'re-adding needs a new approval');
 f.advance(2000);const again=await f.authorize({resources:{model:[id],store:[STORE_ID]}});assert.equal(await live(),false,'X8-R2: a token from the earlier approval stays inactive after reapproval');
 c=await claimsOf(again);assert.equal(await live(),true);
 await f.s.revokeToken({token:again.refresh_token,clientId:APP});assert.equal(await live(),false,'X8-R3: the consumer session ended');
});

test('brokered-resources.v1 is declared through the registry only where mounted, carrying the moved jwks_uri',()=>{
 const config={APP_ORIGIN:ISSUER,INTEGRATIONS_ENABLED:'true',BROKERING_ENABLED:'true'};
 assert.deepEqual(federationDeclarations(config,{target:'authority',mounts:{integrations:true,brokeredResources:true}}),{token_endpoint_auth_methods_supported:['none','private_key_jwt'],features:{'integrations.v1':{},'brokered-resources.v1':{jwks_uri:`${ISSUER}/oauth/brokering/jwks`,preferences_contract:PREFERENCES_V2}}});
 assert.equal(federationDeclarations(config,{target:'authority',mounts:{integrations:true,brokeredResources:true,brokeredIntrospection:true}}).features['brokered-resources.v1'].introspection_endpoint,`${ISSUER}/oauth/brokering/introspect`);
 for(const [c,mounts] of [[config,{brokeredResources:true}],[config,{integrations:true}],[{...config,BROKERING_ENABLED:'false'},{integrations:true,brokeredResources:true}],[{...config,INTEGRATIONS_ENABLED:'false'},{integrations:true,brokeredResources:true}]])assert.deepEqual(federationDeclarations(c,{target:'authority',mounts}),{});
 assert.deepEqual(federationDeclarations(config,{target:'entries',mounts:{integrations:true,brokeredResources:true}}),{});
});

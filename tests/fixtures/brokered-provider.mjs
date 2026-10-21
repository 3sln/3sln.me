// EXT-X8 preferences/v2 (packages/federation/service.mjs projection, mint and confirm paths) over a real federation
// service and the real X7/X8 account engines: the uniform reference shape with minted brokered credentials, v1 left
// unchanged (brokered occupants withheld), AMD-C3 mixed approval, attenuation by grant, severance reported as
// `unavailable`, the grant-revocation race, integration `seq`, the X6 snapshot port, the federation half of
// introspection, the issuer gateway refusing brokered tokens and references, and the feature declaration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash,randomUUID} from 'node:crypto';
import {createAppEngine,perform} from '../../packages/app/engine.mjs';
import {memoryAudit} from '../../packages/app/providers.mjs';
import {AppConnections} from '../../packages/apps/connections.mjs';
import * as C from '../../packages/app/domains/connections.mjs';
import * as B from '../../packages/federation/brokered.mjs';
import * as X from '../../packages/federation/introspection.mjs';
import {FederationService,MemoryFederationStore,PREFERENCES} from '../../packages/federation/index.mjs';
import {PREFERENCES_V2} from '../../packages/federation/service.mjs';
import {DiscoveryClient,DiscoveryBudget,createIntegrationEgress} from '../../packages/federation/resource-discovery.mjs';
import {validateIntegrationManifest} from '../../packages/federation/integrations.mjs';
import {brokeringKeys,mintAccessToken,verifyAccessToken} from '../../packages/federation/signing.mjs';
import {federationDeclarations} from '../../packages/runtime/federation.mjs';
import {SqliteMetadata} from '../../apps/node/resources.mjs';
import {fakeClock} from '../helpers/chaos.mjs';

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
export async function brokeredProvider(t,{connections=false,seq,introspection=false,refreshEnabled=false}={}){
 const metadata=new SqliteMetadata(':memory:');await metadata.put('owner',OWNER);t.after(()=>metadata.close());
 const clock=fakeClock(Date.now()),random={uuid:()=>crypto.randomUUID(),bytes:k=>crypto.getRandomValues(new Uint8Array(k))},audit=memoryAudit({clock});let n=0;
 const cx=createAppEngine({providers:{clock,random,audit,connections:C.connectionsProvider({connections:new AppConnections({metadata,origin:ISSUER,clock:clock.now,uuid:()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`}),enabled:true,account:async()=>({status:'active'})})}});
 const items=host=>[{id:`https://${host}/r/fast`,label:'Fast model',contracts:[MODEL]},{id:`https://${host}/r/slow`,label:'Slow model',contracts:[MODEL]}];
 const presence={available:true};
 const fetcher=async(url,init)=>{const body=JSON.parse(init.body),host=new URL(url).hostname;return Response.json({v:1,items:(presence.available?items(host):[]).filter(i=>!body.ids||body.ids.includes(i.id)).map(i=>({container:false,facets_applied:[],...i})),cursor:null});};
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
 return {s,owner,presence,clock,metadata,cx,x7,x8,q,integration,register,configure,authorize,read,minted,brokering,bindings,advance:ms=>{now+=ms;clock.advance(ms);}};
}


export {OWNER,ISSUER,SUBJECT,MODEL,FRAGMENT,APP,PINS,STORE,STORE_ID};
export {keys as providerKeys};

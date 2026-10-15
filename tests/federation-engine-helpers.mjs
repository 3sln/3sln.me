// Engine-level federation fixtures shared by tests/federation-engine-edges.test.mjs and tests/federation-chaos.test.mjs:
// a FederationService over an injectable store and fake clock, and direct (non-HTTP) AuthorizationEntries steps.
import {webcrypto,createHash,randomUUID} from 'node:crypto';
import {FederationService,MemoryFederationStore,PREFERENCES} from '../packages/federation/index.mjs';
import {entryBody,appOrigin,issuer as entryIssuer} from './authorization-entry-helpers.mjs';
import {fakeClock} from './helpers/chaos.mjs';
/** Owner-step context of a helper session (live session, CSRF, exact issuer origin). */
export const ctx=session=>({sessionToken:session.token,csrfToken:session.csrf,origin:entryIssuer});
let remotes=0;
/** Creates an entry from a fresh caller address and reads its nonce and page token, as the provider page would. */
export async function entry(p,overrides={}){const {body,verifier}=entryBody(overrides),{entryId}=await p.entries.create(body,{origin:appOrigin,remote:`remote-${remotes++}`});const view=await p.entries.view(entryId);return {entryId,verifier,nonce:view.entry.nonce,page:{token:view.pageToken}};}
const issuer='https://provider.example',subject=`${issuer}/entities/alice`,fragment='https://schema.example/preferences/v1',contract='https://spec.bindle.example/contracts/object-store/v1',callback='https://app.example/callback',app='https://app.example/client';
const schema={id:fragment,title:'Settings',description:'Shared settings',publisher:'https://schema.example',fields:{theme:{title:'Theme',type:'enum',values:['dark','light']},stores:{title:'Files',type:'resource',cardinality:{min:0,max:4},contracts:[contract]}}};
const r1=`${issuer}/resources/one`;
const pkce=verifier=>createHash('sha256').update(verifier).digest('base64url');
export const owner={session:'verified'};
export async function serviceFixture({refreshEnabled=true,store=new MemoryFederationStore(),clock=fakeClock()}={}){
 const service=new FederationService({issuer,refreshEnabled,crypto:webcrypto,clock:clock.now,store,clients:[{id:app,name:'Example app',origin:'https://app.example',redirectUris:[callback]}],schemaHosts:['schema.example'],schemaFetcher:async()=>structuredClone(schema),authenticateOwner:async authority=>{if(authority!==owner)throw Object.assign(new Error('unauthorized'),{code:'unauthorized'});return {subject};},dispatchCapability:async()=>({ok:true})});
 await service.registerResource(owner,{id:r1,label:'One',contracts:{[contract]:['get','put']}});await service.configure(owner,{fragment,values:{theme:'dark',stores:[r1]}});
 const connect=async()=>{const verifier=randomUUID()+randomUUID(),{requestId}=await service.beginAuthorization({clientId:app,redirectUri:callback,challenge:pkce(verifier),challengeMethod:'S256',state:'state',requests:[{fragment,required:true,purpose:'Sync',fields:['theme','stores'],methods:{stores:{[contract]:['get']}}}]});const view=await service.inspect(requestId,owner);const decision=await service.approve(owner,{requestId,approved:[{fragment,revision:view.requests[0].revision,fields:['theme','stores'],resources:{stores:[r1]},methods:{stores:{[contract]:['get']}}}]});return {code:new URL(decision.redirectUri).searchParams.get('code'),verifier};};
 const exchange=code=>service.exchange({...code,clientId:app,redirectUri:callback});
 const refresh=refreshToken=>service.refresh({refreshToken,clientId:app});
 const read=token=>service.rpc(token,{version:'0',tx:randomUUID(),resource:'@preferences',contract:PREFERENCES,method:'read',args:{fragment}});
 const call=(token,resource=r1)=>service.rpc(token,{version:'0',tx:randomUUID(),resource,contract,method:'get',args:{key:'k'}});
 // Live means the bearer authenticates (a scope refusal is still a live bearer); dead means `unauthorized`.
 const alive=async(token,resource)=>{try{await call(token,resource);return true;}catch(error){if(error.code==='unauthorized')return false;throw error;}};
 const rows=async prefix=>(await store.transaction(tx=>tx.list(prefix))).length;
 return {service,store,clock,connect,exchange,refresh,read,call,alive,rows};
}

export {app,callback,pkce,fragment,contract,r1};

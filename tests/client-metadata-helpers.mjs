// Shared fixtures for client-id-metadata.v1 tests: a fake SSRF-safe egress port and a real provider stack (owner
// controllers, routing authority, entry store, HTTP handlers) with metadata clients enabled. Reserved .example hosts.
import {webcrypto,createHash,randomUUID} from 'node:crypto';
import {FederationController} from '../packages/federation/runtime.mjs';
import {MemoryFederationStore} from '../packages/federation/index.mjs';
import {federationAuthority,federationClients,federationClientDirectory} from '../packages/runtime/federation.mjs';
import {AuthorizationEntries} from '../packages/federation/authorization-entries.mjs';
import {handleAuthorizationEntry} from '../packages/runtime/federation-entry-http.mjs';
import {handleFederation} from '../packages/federation/http.mjs';
import {base64url} from '../packages/messaging/store.mjs';
export const issuer='https://provider.example',appOrigin='https://app.example',clientId='https://app.example/bindle-client.json',redirectUri='https://app.example/callback';
export const reviewedId='https://reviewed.example/client',reviewedOrigin='https://reviewed.example';
export const metadata=(overrides={})=>({client_id:clientId,client_name:'Example App',redirect_uris:[redirectUri],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],...overrides});
export const b64=size=>base64url(webcrypto.getRandomValues(new Uint8Array(size)));
export const pkce=verifier=>createHash('sha256').update(verifier).digest('base64url');
export const body=value=>new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value));
/** Fake egress: answers from `documents` (url → Response factory or JSON value) and records every call. */
export function fakeEgress(documents={}){
 const calls=[];
 const fetch=async(url,init={})=>{calls.push({url,init});const entry=documents[url];if(typeof entry==='function')return entry(init);if(entry===undefined)return new Response('missing',{status:404});return new Response(body(entry),{status:200,headers:{'Content-Type':'application/json'}});};
 return {fetch,calls};
}
export async function cimdProvider({documents={[clientId]:metadata()},enabled=true,blocked=new Set(),handles=['alex'],withReviewed=true}={}){
 let offset=0;const clock=()=>Date.now()+offset;
 const owners=new Map(handles.map(handle=>[randomUUID(),{handle,status:'active',sessions:new Map()}]));
 const config={APP_ORIGIN:issuer,FEDERATION_ENABLED:'true',FEDERATION_ENTRY_ENABLED:'true',CLIENT_METADATA_ENABLED:enabled?'true':'false',FEDERATION_REFRESH_ENABLED:'true',FEDERATION_CLIENTS:JSON.stringify(withReviewed?[{id:reviewedId,name:'Reviewed app',origin:reviewedOrigin,redirectUris:['https://reviewed.example/callback']}]:[]),FEDERATION_SCHEMAS:'{}',KEY_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')};
 const egress=fakeEgress(documents),clients=federationClients(config);
 const dir=federationClientDirectory(config,{fetch:egress.fetch,blocked:async host=>blocked.has(host)});
 const repository={get:async id=>owners.has(id)?{id,...owners.get(id)}:null,findByHandle:async handle=>{for(const [id,o]of owners)if(o.handle===handle)return {id,...o};return null;}};
 const shards=new Map(),stores=new Map();
 const shard=owner=>{if(!shards.has(owner)){const subject=`${issuer}/entities/${owner}`;if(!stores.has(owner))stores.set(owner,new MemoryFederationStore());shards.set(owner,new FederationController({metadata:stores.get(owner),issuer,clients,crypto:webcrypto,clock,routingKey:owner,refreshEnabled:true,clientMetadata:enabled,dpop:{secret:config.KEY_ENCRYPTION_KEY},schemaHosts:[],schemaFetcher:async()=>{throw new Error('no schemas');},dispatcher:async()=>({ok:true}),
  auth:{owner:async(context,{mutation})=>{const [id]=String(context?.sessionToken??'').split('.'),record=owners.get(id),session=record?.sessions.get(context.sessionToken);if(!record||!session)throw Object.assign(new Error('Sign in to continue.'),{code:'unauthorized'});if(mutation&&(context.csrfToken!==session.csrf||context.origin!==issuer))throw Object.assign(new Error('csrf'),{code:'csrf'});if(id!==owner)throw Object.assign(new Error('forbidden'),{code:'forbidden'});return {subject,epoch:'epoch-1',authTime:session.createdAt};}}}));}return shards.get(owner);};
 const authority=federationAuthority({config,repository,shard,clock,directory:dir});
 const entries=new AuthorizationEntries({store:new MemoryFederationStore(),issuer,clients,authority,crypto:webcrypto,clock,dpop:true,directory:dir,clientMetadata:enabled});
 const assets={fetch:async()=>new Response('<!doctype html><title>Authorize</title>',{headers:{'Content-Type':'text/html'}})};
 const fetch=async(input,init)=>{const request=input instanceof Request?input:new Request(input,init);
  const response=await handleAuthorizationEntry(request,{entries,issuer,assets,remote:async r=>r.headers.get('X-Test-Remote')??'test-remote'})??await handleFederation(request,{controller:authority,issuer,assets})??new Response('Not found',{status:404});
  if(new URL(request.url).pathname!=='/.well-known/bindle/manifest.json'||!response.ok)return response;
  const manifest=await response.json(),extra=entries.manifest();return new Response(JSON.stringify({...manifest,features:{...manifest.features,...extra.features}}),{status:200,headers:response.headers});};
 const accounts=[...owners].map(([owner,o])=>({owner,handle:o.handle,subject:`${issuer}/entities/${owner}`}));
 const signIn=(account=accounts[0])=>{const token=`${account.owner}.${b64(32)}`,csrf=b64(16);owners.get(account.owner).sessions.set(token,{createdAt:clock(),csrf});return {token,csrf,cookie:`__Host-bindle_session=${token}`,account};};
 return {config,egress,directory:dir,blocked,authority,entries,shards,shard,fetch,accounts,signIn,restart:owner=>shards.delete(owner),advance:ms=>{offset+=ms;}};
}

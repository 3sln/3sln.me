// Real federation stack for entry, app-session and embed tests: per-owner FederationController shards behind the
// runtime routing authority, the pre-owner entry store and the actual HTTP handlers. Fixtures use .example hosts.
import {webcrypto,createHash,randomUUID} from 'node:crypto';
import {FederationController} from '../packages/federation/runtime.mjs';
import {MemoryFederationStore} from '../packages/federation/index.mjs';
import {federationAuthority,federationClients} from '../packages/runtime/federation.mjs';
import {AuthorizationEntries} from '../packages/federation/authorization-entries.mjs';
import {DPOP_TYP} from '../packages/federation/dpop.mjs';
import {handleAuthorizationEntry,handleEmbedAPI} from '../packages/runtime/federation-entry-http.mjs';
import {handleFederation} from '../packages/federation/http.mjs';
import {base64url,digest} from '../packages/messaging/store.mjs';
export const issuer='https://provider.example',embedOrigin='https://embed.provider.example',clientId='https://app.example/client',redirectUri='https://app.example/callback',appOrigin='https://app.example';
export const fragment='https://schema.example/settings/v1';
const schema={id:fragment,title:'Settings',description:'Shared settings',publisher:'https://schema.example',fields:{theme:{title:'Theme',type:'enum',values:['dark','light']}}};
export const pkce=verifier=>createHash('sha256').update(verifier).digest('base64url');
export const b64=size=>base64url(webcrypto.getRandomValues(new Uint8Array(size)));
// `store` replaces the entry store and `shardStore(owner)` each owner shard's metadata, so engine tests can wrap them
// with tests/helpers/chaos.mjs schedulers or fault injection.
export async function provider({endSession,limits,handles=['alex','sam'],refreshEnabled=true,entryConfig=true,avatars={},embed={},store,shardStore=()=>new MemoryFederationStore()}={}){
 // A frozen clock that moves only through time.advance, so expiry and freshness never depend on test speed.
 const start=Date.now();let offset=0;const clock=()=>start+offset,time={advance:ms=>offset+=ms};
 const owners=new Map(handles.map(handle=>[randomUUID(),{handle,status:'active',sessions:new Map()}]));
 const config={APP_ORIGIN:issuer,FEDERATION_ENABLED:'true',FEDERATION_CLIENTS:JSON.stringify([{id:clientId,name:'Example app',origin:appOrigin,redirectUris:[redirectUri]}]),FEDERATION_SCHEMAS:JSON.stringify({[fragment]:schema}),KEY_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),...entryConfig?{FEDERATION_ENTRY_ENABLED:'true',EMBED_ORIGIN:embedOrigin}:{}};
 const clients=federationClients(config),repository={get:async id=>owners.has(id)?{id,...owners.get(id)}:null,findByHandle:async handle=>{for(const [id,o]of owners)if(o.handle===handle)return {id,...o};return null;}};
 const shards=new Map(),failures={beginEntry:0};
 const shard=owner=>{if(!shards.has(owner)){const subject=`${issuer}/entities/${owner}`;const controller=new FederationController({metadata:shardStore(owner),issuer,clients,crypto:webcrypto,clock,routingKey:owner,refreshEnabled,schemaHosts:['schema.example'],schemaFetcher:async()=>structuredClone(schema),dispatcher:async()=>({ok:true}),dpop:{secret:config.KEY_ENCRYPTION_KEY},embedOrigin,embedView:async s=>({handle:owners.get(s.split('/').at(-1)).handle,name:'Display '+owners.get(s.split('/').at(-1)).handle,avatar:avatars[owners.get(s.split('/').at(-1)).handle]??null}),
   auth:{owner:async(context,{mutation})=>{const [id]=String(context?.sessionToken??'').split('.'),record=owners.get(id),session=record?.sessions.get(context.sessionToken);if(!record||record.status!=='active'||!session)throw Object.assign(new Error('Sign in to continue.'),{code:'unauthorized'});if(mutation&&(context.csrfToken!==session.csrf||context.origin!==issuer))throw Object.assign(new Error('csrf'),{code:'csrf'});if(id!==owner)throw Object.assign(new Error('forbidden'),{code:'forbidden'});return {subject,epoch:'epoch-1',authTime:session.createdAt};}}});
   const begin=controller.beginEntryAuthorization.bind(controller);controller.beginEntryAuthorization=async(...args)=>{if(failures.beginEntry>0){failures.beginEntry--;throw Object.assign(new Error('Temporarily unavailable.'),{code:'temporarily_unavailable'});}return begin(...args);};
   shards.set(owner,controller);}return shards.get(owner);};
 const authority=federationAuthority({config,repository,shard,clock});
 const ended=[];const entries=new AuthorizationEntries({store:store??new MemoryFederationStore(),issuer,clients,authority,embedOrigin,crypto:webcrypto,clock,dpop:true,limits,endSession:Boolean(endSession)});
 // Session-ending hook double: records the subject and the caller's authenticated owner (the real hook is in http.mjs).
 const endHook=async(request,context,subject)=>{ended.push({context,subject});return typeof endSession==='function'?endSession(request,context,subject):[];};
 const assets={fetch:async()=>new Response('<!doctype html><title>Authorize</title>',{headers:{'Content-Type':'text/html'}})};
 const log=[];
 const fetch=async(input,init)=>{const request=input instanceof Request?input:new Request(input,init);log.push({method:request.method,url:request.url,headers:Object.fromEntries(request.headers)});
  const response=await handleEmbedAPI(request,{authority,embedOrigin,...embed})??await handleAuthorizationEntry(request,{entries,issuer,assets,remote:async r=>r.headers.get('X-Test-Remote')??'test-remote',...endSession?{endSession:endHook}:{}})??await handleFederation(request,{controller:authority,issuer,assets})??new Response('Not found',{status:404});
  // As the root adapter does: mounted entry routes (and here the embed origin) join the core manifest (review F8).
  if(new URL(request.url).pathname!=='/.well-known/bindle/manifest.json'||!response.ok||!entryConfig)return response;
  const manifest=await response.json(),extra=entries.manifest({components:true});return new Response(JSON.stringify({...manifest,features:{...manifest.features,...extra.features},...extra.profiles?{profiles:extra.profiles}:{}}),{status:200,headers:response.headers});};
 const accounts=[...owners].map(([owner,o])=>({owner,handle:o.handle,subject:`${issuer}/entities/${owner}`}));
 /** First-party sign-in: a session whose createdAt is the auth time. */
 const signIn=(account=accounts[0],createdAt=clock())=>{const token=`${account.owner}.${b64(32)}`,csrf=b64(16);owners.get(account.owner).sessions.set(token,{createdAt,csrf});return {token,csrf,cookie:`__Host-bindle_session=${token}`,account};};
 return {config,clock,time,owners,accounts,shard,shards,authority,entries,fetch,log,signIn,ended,failures};
}
export const post=(p,url,body,headers={})=>p.fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
export const form=(p,url,fields,headers={})=>p.fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(fields)});
export function entryBody(overrides={}){const verifier=b64(48);return {verifier,body:{clientId,redirectUri,challenge:pkce(verifier),challengeMethod:'S256',state:b64(32),intent:'login',requests:[],presentation:'popup',...overrides}};}
export async function createEntry(p,overrides={},headers={Origin:appOrigin}){const {verifier,body}=entryBody(overrides);const response=await post(p,`${issuer}/api/oauth/entries`,body,headers);const json=await response.json();return {response,entryId:json.entryId,verifier,body};}
/** Headers of a provider-page mutation: exact Origin, browser Fetch Metadata and the entry's page token from its view. */
export const pageHeaders=(view,extra={})=>({Origin:issuer,'Sec-Fetch-Site':'same-origin','X-Bindle-Entry-Token':view.pageToken,...extra});
export const viewOf=async(p,entryId)=>(await p.fetch(`${issuer}/api/oauth/entries/${entryId}`,{headers:{Origin:issuer}})).json();
/** The static provider page: view, choose an owner, then decide through the entry route. */
export async function providerPage(p,entryId,session,{decision='approve',pageSecret,plain,approved}={}){
 const view=await viewOf(p,entryId);if(!view.entry)return {view};
 // The plain page declares plain mode when it loads, before any owner step.
 if(plain)await post(p,`${issuer}/api/oauth/entries/${entryId}/plain`,{},pageHeaders(view));
 const headers=pageHeaders(view,{Cookie:session.cookie,'X-CSRF-Token':session.csrf});
 const extra={...pageSecret?{pageSecret}:{},...plain?{plain:true}:{}};
 const selected=await post(p,`${issuer}/api/oauth/entries/${entryId}/select`,{nonce:view.entry.nonce,...extra},headers);const selection=await selected.json();if(!selected.ok)return {view,selected,selection};
 const inspect=await(await p.fetch(`${issuer}/api/oauth/requests/${selection.requestId}`,{headers:{Origin:issuer,Cookie:session.cookie}})).json();
 const decided=await post(p,`${issuer}/api/oauth/entries/${entryId}/decision`,{nonce:view.entry.nonce,...extra,...decision==='approve'?{approved:approved??inspect.requests.map(r=>({fragment:r.fragment,fields:r.fields,revision:r.revision}))}:{denied:true}},headers);
 return {view,selection,inspect,decided,result:await decided.json()};
}
export async function exchange(p,code,verifier,{dpop,headers={}}={}){return form(p,`${issuer}/oauth/token`,{grant_type:'authorization_code',code,code_verifier:verifier,client_id:clientId,redirect_uri:redirectUri},{Origin:appOrigin,...dpop?{DPoP:dpop}:{},...headers});}
export async function refresh(p,token,{dpop}={}){return form(p,`${issuer}/oauth/token`,{grant_type:'refresh_token',refresh_token:token,client_id:clientId},{Origin:appOrigin,...dpop?{DPoP:dpop}:{}});}
/** A non-extractable P-256 key that signs DPoP-style proofs. */
export async function dpopKey(){
 const pair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']),{kty,crv,x,y}=await webcrypto.subtle.exportKey('jwk',pair.publicKey),jwk={kty,crv,x,y};
 const jkt=await digest(webcrypto,`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`);
 const sign=async({htm='POST',htu,nonce,ath,typ=DPOP_TYP,iat=Math.floor(Date.now()/1000),jti=b64(18),claims={},header={}})=>{const enc=value=>base64url(new TextEncoder().encode(JSON.stringify(value)));const head=enc({typ,alg:'ES256',jwk,...header}),body=enc({jti,htm,htu,iat,...nonce!==undefined?{nonce}:{},...ath!==undefined?{ath:await digest(webcrypto,ath)}:{},...claims});return `${head}.${body}.${base64url(new Uint8Array(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(`${head}.${body}`))))}`;};
 return {jwk,jkt,sign};
}
export const tokenNonce=async p=>p.authority.dpopNonce('token');
export const embedHeaders=(extra={})=>({Origin:embedOrigin,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty','X-Bindle-Embed':'1',...extra});
export async function embedNonce(p){return (await(await p.fetch(`${embedOrigin}/embed/api/nonce`,{method:'POST',headers:embedHeaders()})).json()).nonce;}
export const codeOf=url=>new URL(url).searchParams.get('code');

import {federationSchemas} from './federation.mjs';
import {verifyProof,dpopNonces,consumeProof,DPOP_TYP} from '../federation/dpop.mjs';
import {consentContracts} from '../consent/contracts.mjs';
// IA-1/IA-2 composition (docs/spec/incremental-authorization.md). Shared by the Worker and Node adapters. Nothing is
// reachable unless INCREMENTAL_AUTH_ENABLED is on AND the adapter builds `INCREMENTAL_AUTHORIZATION` from an
// `incremental` provider whose ports reach the owner's federation shard (grants, preferences, sessions): only then does
// the runner report `mounted`, AuthorizationEntries accept and list `grant-more`/`configure` (so the existing
// `authorization-entry.v1` declaration row advertises them), and the routes below answer. Every engine operation
// still answers `not_found` with the flag off (incremental.mjs).
//
// `INCREMENTAL_AUTHORIZATION` is the adapter port: `{mounted, admit, begin, decide, abandon, exchange, cleanup,
// suppressionList, suppressionAdd, suppressionRemove, suppressionExport, suppressionErase, ownerActed}`, each one
// engine operation dispatched through a short-lived app engine. The same object is the `incremental` option of
// AuthorizationEntries.
import {createAppEngine,perform,read} from '../app/engine.mjs';
import {systemClock,cryptoRandom,nullAudit} from '../app/providers.mjs';
import {IncrementalAdmit,IncrementalBegin,IncrementalDecide,IncrementalAbandon,IncrementalExchange,IncrementalCleanup,IncrementalLoginDelta,IncrementalLoginOutcome} from '../federation/incremental.mjs';
import {SuppressionList,SuppressionAdd,SuppressionRemove,SuppressionExport,SuppressionErase,RequestOwnerActed} from '../federation/suppression.mjs';

export const incrementalAuthorizationEnabled=config=>config?.INCREMENTAL_AUTH_ENABLED===true||config?.INCREMENTAL_AUTH_ENABLED==='true';
/** Mount evidence: the flag plus the entry routes the intents ride on. The adapter still has to supply the provider. */
export const incrementalMountable=config=>incrementalAuthorizationEnabled(config)&&config.FEDERATION_ENABLED==='true'&&config.FEDERATION_ENTRY_ENABLED==='true';
/** The adapter port over one `incremental` provider; null (unmounted) with the flag off. */
export function incrementalRunner({config,incremental,clock=systemClock}){
 if(!incrementalAuthorizationEnabled(config)||!incremental)return null;
 const engine=()=>createAppEngine({providers:{config,incremental,clock,random:cryptoRandom,audit:nullAudit}});
 const act=async(Kind,input,actor)=>{const e=engine();try{return await perform(e,new Kind({input,...actor?{actor}:{}}));}finally{await e.dispose();}};
 const query=async(Kind,input,actor)=>{const e=engine();try{return await read(e,new Kind({input,actor}));}finally{await e.dispose();}};
 const owner=id=>({kind:'owner',owner:id});
 return Object.freeze({mounted:true,admit:input=>act(IncrementalAdmit,input),begin:input=>act(IncrementalBegin,input),decide:input=>act(IncrementalDecide,input),abandon:input=>act(IncrementalAbandon,input),exchange:input=>act(IncrementalExchange,input),cleanup:input=>act(IncrementalCleanup,input),loginDelta:input=>act(IncrementalLoginDelta,input),loginOutcome:input=>act(IncrementalLoginOutcome,input),
  suppressionList:(id,input)=>query(SuppressionList,input,owner(id)),suppressionAdd:(id,input)=>act(SuppressionAdd,input,owner(id)),suppressionRemove:(id,input)=>act(SuppressionRemove,input,owner(id)),
  suppressionExport:id=>query(SuppressionExport,{},owner(id)),suppressionErase:id=>act(SuppressionErase,{},owner(id)),ownerActed:(id,input)=>act(RequestOwnerActed,input,owner(id))});
}
const NO_STORE={'Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Content-Type':'application/json'};
const CODE=/^ia1\.[A-Za-z0-9_-]{43}$/;
const oauth=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{...NO_STORE,...headers}});
/** Token-endpoint branch for incremental codes (`ia1.` prefix): picked out before the generic federation exchange, as
 * the device_code branch is (routes/federation.mjs). Returns null for every other request so that handler runs.
 * `proofs.verify(proof,{htm,htu})` → the verified DPoP key thumbprint (the federation DPoP verifier and nonces);
 * `origins(origin)` says whether a browser origin may read the response (registered client origins). */
export async function handleIncrementalToken(request,{port,issuer,proofs,origins=()=>false,authorizeClient=()=>{}}){
 if(port?.mounted!==true||new URL(request.url).pathname!=='/oauth/token'||request.method!=='POST'||request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/x-www-form-urlencoded')return null;
 if(Number(request.headers.get('Content-Length'))>8192)return null;const reader=request.clone().body?.getReader(),chunks=[];let size=0;if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){void reader.cancel();return null;}chunks.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}const params=new URLSearchParams(text);
 if(params.get('grant_type')!=='authorization_code'||!CODE.test(params.get('code')??''))return null;
 const origin=request.headers.get('Origin'),cors=origin&&await origins(origin,params.get('client_id'))?{'Access-Control-Allow-Origin':origin,Vary:'Origin'}:{};
 const names=[...params.keys()];if(new Set(names).size!==names.length||names.some(name=>!['grant_type','code','redirect_uri','client_id','code_verifier'].includes(name)))return oauth({error:'invalid_request'},400,cors);
 try{await authorizeClient(params.get('client_id'));}catch{return oauth({error:'invalid_client'},400,cors);}
 let dpopJkt;const proof=request.headers.get('DPoP'),nonceHeaders=async()=>proof!==null&&proofs.nonce?{'DPoP-Nonce':await proofs.nonce(),'Access-Control-Expose-Headers':'DPoP-Nonce'}:{};
 if(proof!==null){try{dpopJkt=await proofs.verify(proof,{htm:'POST',htu:`${issuer}/oauth/token`});}catch(error){return oauth({error:error?.code==='use_dpop_nonce'?'use_dpop_nonce':'invalid_dpop_proof'},400,{...cors,...await nonceHeaders()});}if(typeof dpopJkt!=='string')return oauth({error:'invalid_dpop_proof'},400,cors);}
 try{return oauth(await port.exchange({clientId:params.get('client_id'),code:params.get('code'),redirectUri:params.get('redirect_uri'),codeVerifier:params.get('code_verifier'),...dpopJkt?{dpopJkt}:{}}),200,{...cors,...await nonceHeaders()});}
 catch(error){if(error?.code==='temporarily_unavailable')return oauth({error:'temporarily_unavailable'},503,{...cors,'Retry-After':'5'});return oauth({error:['invalid_grant','not_found'].includes(error?.code)?'invalid_grant':'invalid_request'},400,cors);}
}

import {createIncrementalProvider} from '../federation/incremental.mjs';
import {createConsentProvider} from '../consent/index.mjs';
import {clientSite} from '../federation/client-metadata.mjs';
import {pinSchema} from '../federation/schema.mjs';
/** Durable pre-owner state; all owner data is read/committed on its FederationService shard. */
export function federationIncremental({config,store,shard}){
 if(!incrementalMountable(config))return null;
 const schemas=federationSchemas(config),clients=typeof config.FEDERATION_CLIENTS==='string'?JSON.parse(config.FEDERATION_CLIENTS):config.FEDERATION_CLIENTS??[];
 const call=name=>input=>{const prefix=`${config.APP_ORIGIN}/entities/`,owner=input?.subject?.startsWith(prefix)?input.subject.slice(prefix.length):'';if(!/^[a-f0-9-]{36}$/.test(owner))throw Object.assign(new Error('Invalid account.'),{code:'forbidden'});return shard(owner).incrementalPort(name,input);};
 const provider=createIncrementalProvider({store,issuer:config.APP_ORIGIN,registrableDomain:clientSite,clients:id=>clients.find(c=>c.id===id),consent:{model:async input=>createConsentProvider({contracts:await consentContracts(),manifests:Object.fromEntries(Object.entries(schemas).map(([url,schema])=>[url,{schema}])),apps:Object.fromEntries(clients.map(c=>[c.id,{reviewed:true}])),registrableDomain:clientSite}).model(input)},
  pinSchema:url=>pinSchema({store,crypto,schemaHosts:Object.keys(schemas).map(url=>new URL(url).host),schemaFetcher:async url=>{if(!Object.hasOwn(schemas,url))throw Object.assign(new Error('Unsupported fragment.'),{code:'unsupported_fragment'});return structuredClone(schemas[url]);}},url),
  grants:Object.fromEntries(['connection','siteConnection','current','commit'].map(n=>[n,call(n)])),preferences:Object.fromEntries(['read','receivers','candidates','save'].map(n=>[n,call(n)])),sessions:Object.fromEntries(['newest','issue','revoke'].map(n=>[n,call(n)]))});
 const runner=incrementalRunner({config,incremental:provider}),nonces=dpopNonces({secret:config.DPOP_NONCE_KEY||config.KEY_ENCRYPTION_KEY});
 return Object.freeze({...runner,tokenNonce:()=>nonces.issue('token'),async tokenProof(proof){const verified=await verifyProof(crypto,proof,{typ:DPOP_TYP,htm:'POST',htu:`${config.APP_ORIGIN}/oauth/token`,now:Date.now(),nonce:value=>nonces.check('token',value)});await store.transaction(tx=>consumeProof(tx,'incremental-dpop/',verified,crypto,Date.now));return verified.jkt;},async cleanup(input){const result=await runner.cleanup(input);await store.transaction(async tx=>{for(const row of await tx.list('incremental-dpop/'))if(row.value.expiresAt<=Date.now())await tx.delete(row.key);});return result;}});
}
export const INCREMENTAL_STORE='bindle-incremental-v1';
export const INCREMENTAL_METHODS=['admit','begin','decide','abandon','exchange','cleanup','loginDelta','loginOutcome','tokenProof','tokenNonce','suppressionList','suppressionAdd','suppressionRemove','suppressionExport','suppressionErase','ownerActed'];
export function incrementalRemote(invoke){return Object.freeze({mounted:true,...Object.fromEntries(INCREMENTAL_METHODS.map(method=>[method,async(...args)=>{const envelope=await invoke(method,args);if(!envelope.ok)throw Object.assign(new Error(envelope.error.message),envelope.error);return envelope.result;}]))});}

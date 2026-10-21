// IA-3, provisional incremental-authorization §3–§7. Import lazily after the app's
// default-off INCREMENTAL_AUTH_ENABLED gate; no element/first-render imports.
import {Engine,Provider,Action,Query} from '../../../vendor/ngin/index.js';
import {createSession} from './flows.mjs';
import {issuerURL,declarationLimits,notImplemented} from './capabilities.mjs';
import {boundedJSON,deepFreeze,validateAccessResponse} from './tokens.mjs';
import {createKey,createProof} from './dpop.mjs';

const intents=['grant-more','configure'],outcomes=['granted','partial','declined','unsupported','unavailable'];
const coded=code=>Object.assign(new Error(code),{code}),object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const random=crypto=>encode(crypto.getRandomValues(new Uint8Array(32)));
const names=value=>Array.isArray(value)&&value.length>0&&value.length<=64&&new Set(value).size===value.length&&value.every(name=>typeof name==='string'&&name.length>0&&name.length<=2048);
const url=value=>{try{const parsed=new URL(value);return typeof value==='string'&&value.length<=2048&&parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&!parsed.hash&&parsed.href===value;}catch{return false;}};
const check=signal=>{if(signal?.aborted)throw coded('canceled');};
const same=(session,pending)=>session?.issuer===pending.issuer&&session?.subject===pending.subjectConstraint;
const grantKey=client=>JSON.stringify([client.generation,client.session?.issuer,client.session?.subject]);
const recordKey=(io,state)=>`${io.storageKey}:${JSON.stringify([io.client.redirectUri,state])}`;
function pending(state,io,key){
 if(typeof key!=='string')return null;
 if(state.pending.has(key))return state.pending.get(key);
 try{const value=JSON.parse(io.client.storage?.getItem(recordKey(io,key)));return value?.state===key?value:null;}catch{return null;}
}
function consume(state,io,key){state.pending.delete(key);try{io.client.storage?.removeItem(recordKey(io,key));}catch{}}
function records(state,io){
 const found=new Map(state.pending),storage=io.client.storage;
 try{for(let index=0;index<(storage?.length??0);index++){const key=storage.key(index);if(!key?.startsWith(io.storageKey+':'))continue;const record=JSON.parse(storage.getItem(key));if(record?.redirectUri===io.client.redirectUri&&typeof record.state==='string')found.set(record.state,record);}}catch{}
 return found;
}
function discard(state,io,key,record){
 consume(state,io,key);
 if(record?.dpopJkt){io.client.dpopKeys.delete(record.dpopJkt);io.client.keyStore?.delete(`${io.client.storageKey}:${record.dpopJkt}`)?.catch?.(()=>{});}
}
function declaration(client,issuer){
 const manifest=client.capabilities.manifest(issuer),base=client.capabilitiesFor(issuer),entry=manifest?.features?.['authorization-entry.v1'];
 if(!base?.entry||!object(entry)||bytes(entry)>declarationLimits.featureBytes||!issuerURL(entry.endpoint,issuer)||!Array.isArray(entry.intents)||entry.intents.length>16||entry.intents.some(value=>typeof value!=='string'||value.length>64))return null;
 return {manifest,base,entry};
}
function validate(intent,input){
 if(!object(input)||Object.keys(input).some(key=>!['requests','reason','target','suggestion'].includes(key))||input.reason!==undefined&&(typeof input.reason!=='string'||[...input.reason].length>200))throw coded('invalid_request');
 if(intent==='grant-more'){
  if(input.target!==undefined||input.suggestion!==undefined||!Array.isArray(input.requests)||!input.requests.length||input.requests.length>4||new Set(input.requests.map(item=>item?.fragment)).size!==input.requests.length)throw coded('invalid_request');
  for(const request of input.requests){
   if(!object(request)||!url(request.fragment)||request.required!==undefined&&request.required!==false||request.digest!==undefined&&!/^sha256-[A-Za-z0-9_-]{43}$/.test(request.digest)||request.fields!==undefined&&!names(request.fields)||request.methods!==undefined&&!object(request.methods))throw coded('invalid_request');
   for(const [field,contracts]of Object.entries(request.methods??{})){
    if(!field||request.fields&&!request.fields.includes(field)||!object(contracts))throw coded('invalid_request');
    for(const [contract,methods]of Object.entries(contracts))if(!url(contract)||!names(methods))throw coded('invalid_request');
   }
  }
 }else{
  const target=input.target;
  if(input.requests!==undefined||!object(target)||Object.keys(target).some(key=>!['fragment','digest','fields'].includes(key))||!url(target.fragment)||target.digest!==undefined&&!/^sha256-[A-Za-z0-9_-]{43}$/.test(target.digest)||target.fields!==undefined&&(!names(target.fields)||target.fields.length>8))throw coded('invalid_request');
  if(input.suggestion!==undefined){
   const suggestion=input.suggestion;
   if(!object(suggestion)||Object.keys(suggestion).join()!=='values'||!object(suggestion.values)||bytes(suggestion)>2048)throw coded('invalid_request');
   for(const [field,value]of Object.entries(suggestion.values))if(!field||target.fields&&!target.fields.includes(field)||!['string','boolean','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw coded('invalid_request');
  }
 }
 if(bytes(input)>8192)throw coded('invalid_request');
 return JSON.parse(JSON.stringify(input));
}
function failure(response,json,io,issuer){
 const code=notImplemented(response.status)?'unsupported-provider':response.status===429||json?.error==='rate_limited'?'rate_limited':json?.error==='invalid_request'?'invalid_request':'network-error',error=coded(code);
 if(code==='unsupported-provider')io.client.capabilities.degrade(issuer,'authorization-entry');
 const retry=response.headers.get('Retry-After');let seconds;
 if(/^\d+$/.test(retry??''))seconds=Number(retry);else if(retry&&Number.isFinite(Date.parse(retry)))seconds=Math.max(0,Math.ceil((Date.parse(retry)-io.clock())/1000));
 if(Number.isSafeInteger(seconds))error.retryAfter=seconds;
 if(issuerURL(json?.owner_review_uri,issuer))error.ownerReviewUri=issuerURL(json.owner_review_uri,issuer);
 return error;
}
function grantResults(requests,token,previous){
 const entries=token.fragment_outcomes??[];
 if(!Array.isArray(entries)||entries.length>4||new Set(entries.map(entry=>entry?.fragment)).size!==entries.length||entries.some(entry=>!object(entry)||!requests.some(request=>request.fragment===entry.fragment)||!outcomes.includes(entry.outcome)))throw coded('invalid_token_response');
 return requests.map(request=>{
  const entry=entries.find(entry=>entry.fragment===request.fragment),outcome=entry?.outcome??'declined',granted=['granted','partial'].includes(outcome)?entry.granted:previous.find(grant=>grant.fragment===request.fragment)??null;
  if(['granted','partial'].includes(outcome)&&(!object(granted)||!Array.isArray(granted.fields)||granted.fields.some(field=>typeof field!=='string')||granted.methods!==undefined&&!object(granted.methods)))throw coded('invalid_token_response');
  const methods=Object.fromEntries(Object.entries(request.methods??{}).map(([field,contracts])=>[field,Object.fromEntries(Object.entries(contracts).map(([contract,requested])=>{
   const held=granted?.fields.includes(field)?granted.methods?.[field]?.[contract]??[]:[];if(!Array.isArray(held)||held.some(method=>typeof method!=='string'))throw coded('invalid_token_response');
   return [contract,{granted:requested.filter(method=>held.includes(method)),missing:requested.filter(method=>!held.includes(method))}];
  }))]));
  return {fragment:request.fragment,outcome,granted,methods};
 });
}
class IncrementalAction extends Action {
 static deps=['incrementalState','incrementalIO'];
 constructor(input={}){super();this.input=input;}
 async execute(resources,context){const result=await this.run(resources,context);context.dispatchFeed.dispatchEvent(new CustomEvent('result',{detail:result}));}
}
export class BeginIncrementalAuthorization extends IncrementalAction {
 static operation='sdk.incremental.begin';
 async run({incrementalState:state,incrementalIO:io},{signal:dispatchSignal}){
  if(!io.enabled)throw coded('incremental-disabled');
  const {intent,presentation='redirect',signal,uiLocales,colorScheme}=this.input,input=validate(intent,this.input.request??{});
  if(!intents.includes(intent)||!['redirect','popup'].includes(presentation))throw coded('invalid_request');
  const session=io.client.session;if(!session)throw coded('no-session');
  const epoch=state.generation,generation=io.client.generation,loginGeneration=io.client.loginGeneration,stopped=AbortSignal.any([dispatchSignal,...signal?[signal]:[]]),active=()=>{check(stopped);if(epoch!==state.generation||io.client.generation!==generation||io.client.loginGeneration!==loginGeneration||!same(io.client.session,{issuer:session.issuer,subjectConstraint:session.subject}))throw coded('canceled');};
  active();await io.client.discoverHost(new URL(session.issuer).host,{signal:stopped});active();
  const declared=declaration(io.client,session.issuer),clientId=io.client.clientIdFor(session.issuer);
  if(!declared?.entry.intents.includes(intent))throw coded('unsupported-provider');if(!clientId)throw coded('unregistered-client');
  const stateKey=random(io.crypto),verifier=intent==='grant-more'?random(io.crypto):undefined,challenge=verifier?encode(new Uint8Array(await io.crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))):undefined;
  // Redirect keys must survive the navigation. An absent persistent keystore
  // deliberately leaves that exchange unbound, as the ordinary SDK flow does.
  const key=intent==='grant-more'&&declared.base.dpop&&(presentation==='popup'||io.client.keyStore)?await createKey(io.crypto):null;
  const body={clientId,redirectUri:io.client.redirectUri,state:stateKey,intent,subjectConstraint:session.subject,presentation,...input,...challenge?{challenge,challengeMethod:'S256'}:{},...key?{dpopJkt:key.jkt}:{},...uiLocales?.length?{uiLocales}:{},...['light','dark'].includes(colorScheme)?{colorScheme}:{}};
  const response=await io.client.fetcher(declared.entry.endpoint,{method:'POST',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([stopped,AbortSignal.timeout(15000)])}),json=await boundedJSON(response).catch(()=>null);active();
  if(!response.ok)throw failure(response,json,io,session.issuer);
  if(typeof json?.entryId!=='string'||! /^[A-Za-z0-9_-]{16,128}$/.test(json.entryId))throw coded('network-error');
  const record={...body,...verifier?{verifier}:{},issuer:session.issuer,tokenEndpoint:declared.manifest.token_endpoint,rpcEndpoint:declared.manifest.rpc_endpoint,preferencesContract:declared.manifest.preferences_contract,revocationEndpoint:declared.manifest.revocation_endpoint,expiresAt:io.clock()+600000,previousGrants:state.grants.get(grantKey(io.client))??session.granted_fragments??[],sessionDeadline:session.refreshExpiresAt??session.expiresAt,authTime:session.auth_time,loginGeneration};
  try{
   if(key){io.client.dpopKeys.set(key.jkt,key);if(presentation==='redirect')await io.client.keyStore.put(`${io.client.storageKey}:${key.jkt}`,key);}
   active();
   const previous=[...records(state,io)].sort((a,b)=>a[1].expiresAt-b[1].expiresAt);
   for(const [id,prior]of previous)if(prior.expiresAt<=io.clock()||prior.issuer===record.issuer&&prior.subjectConstraint===record.subjectConstraint)discard(state,io,id,prior);
   const live=[...records(state,io)];for(const [id,prior]of live.slice(0,Math.max(0,live.length-7)))discard(state,io,id,prior);
   if(presentation==='redirect'){try{io.client.storage.setItem(recordKey(io,stateKey),JSON.stringify(record));}catch{throw coded('storage-unavailable');}}
  }catch(error){discard(state,io,stateKey,record);throw error;}
  state.pending.set(stateKey,record);state.result=null;
  const authorization=new URL(declared.manifest.authorization_endpoint);authorization.searchParams.set('entry',json.entryId);
  return {issuer:session.issuer,state:stateKey,authorizationUrl:authorization.href};
 }
}
export class CompleteIncrementalAuthorization extends IncrementalAction {
 static operation='sdk.incremental.complete';
 async run({incrementalState:state,incrementalIO:io},{signal:dispatchSignal}){
  if(!io.enabled)throw coded('incremental-disabled');
  let callback;try{callback=new URL(this.input.url);}catch{throw coded('invalid-callback');}
  const key=callback.searchParams.get('state'),record=pending(state,io,key),expected=new URL(io.client.redirectUri);
  if(!record||record.expiresAt<=io.clock()||record.redirectUri!==expected.href||record.clientId!==io.client.clientIdFor(record.issuer)||!intents.includes(record.intent)||callback.origin!==expected.origin||callback.pathname!==expected.pathname||callback.username||callback.password||callback.hash||callback.searchParams.get('iss')!==record.issuer)throw coded('invalid-callback');
  const allowed=new Set([...expected.searchParams.keys(),'state','iss',record.intent==='configure'?'result':'code']);
  if([...callback.searchParams.keys()].some(name=>!allowed.has(name)||callback.searchParams.getAll(name).length!==1)||[...expected.searchParams].some(([name,value])=>callback.searchParams.get(name)!==value))throw coded('invalid-callback');
  const result=callback.searchParams.get('result'),code=callback.searchParams.get('code');
  if(record.intent==='configure'?!['configured','unchanged'].includes(result):! /^[A-Za-z0-9_-]{16,2048}$/.test(code??''))throw coded('invalid-callback');
  if(state.pending.has(key)&&(record.loginGeneration!==io.client.loginGeneration||!same(io.client.session,record))){discard(state,io,key,record);throw coded('canceled');}
  consume(state,io,key);state.result=null;
  if(globalThis.location?.origin===callback.origin&&globalThis.location?.pathname===callback.pathname)io.client.history?.replaceState?.(null,'',expected.pathname+expected.search);
  const epoch=state.generation,generation=io.client.generation,loginGeneration=io.client.loginGeneration,signal=AbortSignal.any([dispatchSignal,...this.input.signal?[this.input.signal]:[]]),active=()=>{check(signal);if(epoch!==state.generation||generation!==io.client.generation||loginGeneration!==io.client.loginGeneration||io.client.session&&!same(io.client.session,record))throw coded('canceled');};active();
  if(record.intent==='configure'){
   if(!same(io.client.session,record))throw coded('no-session');
   const preferences=await io.client.readPreferences(record.target.fragment,{signal});active();
   if(!object(preferences)||!Object.hasOwn(preferences,'revision'))throw coded('invalid_preferences');
   return state.result=deepFreeze({outcome:result,preferences});
  }
  for(const endpoint of [record.tokenEndpoint,record.rpcEndpoint,...record.revocationEndpoint?[record.revocationEndpoint]:[]])if(!issuerURL(endpoint,record.issuer))throw coded('invalid-callback');
  const dpopKey=record.dpopJkt?await io.client.dpopKey(record.dpopJkt):null;
  if(record.dpopJkt&&!dpopKey)throw coded('invalid-callback');
  const startedAt=io.clock(),body=new URLSearchParams({grant_type:'authorization_code',code,code_verifier:record.verifier,client_id:record.clientId,redirect_uri:record.redirectUri});let token;
  try{
   for(let attempt=0;attempt<2;attempt++){
    active();const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
    if(dpopKey)headers.DPoP=await createProof(dpopKey,{htu:record.tokenEndpoint,nonce:io.client.dpopNonces.get(record.tokenEndpoint),crypto:io.crypto,clock:io.clock});
    active();const response=await io.client.fetcher(record.tokenEndpoint,{method:'POST',credentials:'omit',redirect:'error',headers,body,signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])}),json=await boundedJSON(response),nonce=response.headers.get('DPoP-Nonce');
    if(dpopKey&&/^[\x21-\x7e]{1,512}$/.test(nonce??''))io.client.dpopNonces.set(record.tokenEndpoint,nonce);
    if(dpopKey&&!response.ok&&json?.error==='use_dpop_nonce'&&/^[\x21-\x7e]{1,512}$/.test(nonce??'')&&attempt===0)continue;
    if(!response.ok)throw failure(response,json,io,record.issuer);token=json;break;
   }
   if(!object(token))throw coded('invalid_token_response');
   active();const fragments=grantResults(record.requests,token,record.previousGrants);let issuedSession;
   if(token.access_token!==undefined){
    try{issuedSession=validateAccessResponse(token,{...record,clock:io.clock,requestStartedAt:startedAt});}catch{throw coded('invalid_token_response');}
    if(!fragments.some(item=>['granted','partial'].includes(item.outcome))||issuedSession.subject!==record.subjectConstraint||issuedSession.expiresAt>record.sessionDeadline||issuedSession.refreshExpiresAt>record.sessionDeadline||record.authTime!==undefined&&(!Number.isSafeInteger(token.auth_time)||token.auth_time>record.authTime))throw coded('invalid_token_response');
   }else if(token.refresh_token!==undefined||fragments.some(item=>item.outcome==='partial'))throw coded('invalid_token_response');
   const current=new Map(record.previousGrants.map(grant=>[grant.fragment,grant]));for(const item of fragments)if(['granted','partial'].includes(item.outcome))current.set(item.fragment,{...item.granted,fragment:item.fragment});
   state.grants.clear();state.grants.set(grantKey(io.client),[...current.values()]);
   return state.result=deepFreeze({outcome:'completed',fragments,...issuedSession?{issuedSession}:{}});
  }catch(error){if(token?.access_token)await io.client.revokeSession({...token,issuer:record.issuer,client_id:record.clientId,revocationEndpoint:record.revocationEndpoint}).catch(()=>false);throw error;}
  finally{if(dpopKey&&!state.result?.issuedSession)io.client.dpopKeys.delete(record.dpopJkt);}
 }
}
export class CancelIncrementalAuthorization extends IncrementalAction {
 static operation='sdk.incremental.cancel';
 run({incrementalState:state,incrementalIO:io}){const key=this.input.state,record=pending(state,io,key);if(!key||record){state.generation++;state.result=null;}if(key)discard(state,io,key,record);else for(const [id,prior]of records(state,io))discard(state,io,id,prior);return true;}
}
export class IncrementalResult extends Query {
 static operation='sdk.incremental.result';static deps=['incrementalState'];
 fetch({incrementalState:state}){return state.result;}
}
export const INCREMENTAL_OPERATIONS=Object.freeze([BeginIncrementalAuthorization,CompleteIncrementalAuthorization,CancelIncrementalAuthorization,IncrementalResult]);
export function createIncrementalEngine({client,enabled=false,crypto=client?.crypto??globalThis.crypto,clock=client?.clock??Date.now,state={pending:new Map(),grants:new Map(),result:null,generation:0}}={}){
 if(!client)throw new TypeError('An existing BindleClient is required.');
 return new Engine({providers:{incrementalState:Provider.fromSingleton(state),incrementalIO:Provider.fromSingleton({client,enabled:enabled===true,crypto,clock,storageKey:client.storageKey+'.incremental'})}});
}
async function perform(engine,action){const feed=engine.dispatch(action);let result;feed.addEventListener('result',event=>{result=event.detail;},{once:true});await feed.next('complete');return result;}
/** Thin transport adapter. Calls must come from the app's explicit user action.
 * It never retries a decision, starts a timer to ask again, or changes app sessions.
 */
export function createIncrementalClient({client,enabled=false,...options}={}){
 const state={pending:new Map(),grants:new Map(),result:null,generation:0},engine=createIncrementalEngine({client,enabled,...options,state}),io={client,storageKey:client.storageKey+'.incremental'};let call=null,busy=false;
 const saveError=async(action,invocation)=>{try{return await perform(engine,action);}catch(caught){invocation.error=caught;throw caught;}};
 const overrides={
  storageKey:io.storageKey,
  capabilitiesFor:issuer=>{const declared=enabled===true?declaration(client,issuer):null,base=client.capabilitiesFor(issuer);return declared?{...base,intents:[...base.intents,...intents.filter(intent=>declared.entry.intents.includes(intent))]}:base;},
  beginAuthorization:args=>{const invocation=call;return saveError(new BeginIncrementalAuthorization({...args,request:invocation.request}),invocation);},
  completeLogin:async url=>{const invocation=call;invocation.completed=await saveError(new CompleteIncrementalAuthorization({url}),invocation);},
  readPending:key=>pending(state,io,key),hasPending:key=>{const record=pending(state,io,key);return !!record&&record.expiresAt>client.clock();},
  cancelLogin:key=>{if(key)perform(engine,new CancelIncrementalAuthorization({state:key})).catch(()=>{});},
 };
 // The ordinary controller owns windows, activation, relay validation and expiry.
 // Only entry creation and completion differ; bind the original client's methods.
 const adapter=new Proxy(client,{get(target,key){if(Object.hasOwn(overrides,key))return overrides[key];const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;},set(target,key,value){if(['islandPolicy','userAgent'].includes(key)){overrides[key]=value;return true;}return Reflect.set(target,key,value,target);}});
 const transport=createSession({...options,client:adapter,transports:[],islands:'off'});
 async function finish(run){
  if(enabled!==true)return {outcome:'unavailable',code:'incremental-disabled'};
  if(busy)return {outcome:'unavailable',code:'authorization-in-progress'};
  busy=true;const invocation={};call=invocation;
  try{const result=await run(),error=invocation.error;return error?{outcome:error.code==='rate_limited'?'rate_limited':'error',code:error.code??'network-error',...error.retryAfter!==undefined?{retryAfter:error.retryAfter}:{},...error.ownerReviewUri?{ownerReviewUri:error.ownerReviewUri}:{}}:invocation.completed??result;}
  finally{busy=false;if(call===invocation)call=null;}
 }
 return {engine,client:adapter,grantMore(request){return finish(()=>{call.request=request;return transport.requestAuthorization('grant-more');});},configure(request){return finish(()=>{call.request=request;return transport.requestAuthorization('configure');});},completeCallback(url){return finish(()=>transport.completeCallback(url));},loadCapabilities:options=>enabled===true?transport.loadCapabilities(options):Promise.resolve(null),result:()=>engine.query(new IncrementalResult()).peek(),cancel(){transport.cancelFlow();return perform(engine,new CancelIncrementalAuthorization());},dispose(){transport.dispose();return engine.dispose();}};
}

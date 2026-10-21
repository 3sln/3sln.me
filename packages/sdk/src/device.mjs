// Non-browser RFC 8628 client (device-authorization.md). This SDK engine is
// deliberately separate from the provider/account engine: no routes are mounted.
import {Engine,Provider,Action,Query} from '../../../vendor/ngin/index.js';
import {createKey,createProof,thumbprint} from './dpop.mjs';
import {boundedJSON,validateAccessResponse} from './tokens.mjs';
import {parseIdentity} from './handle.mjs';

export const deviceGrant='urn:ietf:params:oauth:grant-type:device_code';
const coded=(code,message=code)=>Object.assign(new Error(message),{code});
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const opaque=value=>typeof value==='string'&&value.length>0&&value.length<=8192&&!/[\x00-\x20\x7f]/.test(value);
const seconds=value=>Number.isSafeInteger(value)&&value>0;
const noncePattern=/^[\x21-\x7e]{1,512}$/;
function endpoint(value,issuer,{plain=false}={}){
 let url;try{url=new URL(value);}catch{}
 if(typeof value!=='string'||!url||url.protocol!=='https:'||url.origin!==issuer||url.username||url.password||url.hash||plain&&url.search||url.href!==value)throw coded('unsupported_provider','Expected a canonical HTTPS endpoint on the issuer origin.');
 return value;
}
/** The manifest must come from trusted discovery for the configured issuer. */
export function deviceDeclaration(manifest,issuer){
 let origin;try{origin=new URL(issuer);}catch{}
 if(!origin||origin.origin!==issuer||origin.protocol!=='https:'||!object(manifest)||manifest.issuer!==issuer||manifest.version!=='0'||!object(manifest.features?.['device-authorization.v1'])||!Array.isArray(manifest.grant_types_supported)||![deviceGrant,'refresh_token'].every(grant=>manifest.grant_types_supported.includes(grant))||!Array.isArray(manifest.dpop_signing_alg_values_supported)||!manifest.dpop_signing_alg_values_supported.includes('ES256'))throw coded('unsupported_provider','The provider does not declare the Bindle device profile.');
 const names=['device_authorization_endpoint','token_endpoint','rpc_endpoint','revocation_endpoint'];
 return Object.freeze({issuer,...Object.fromEntries(names.map(name=>[name,endpoint(manifest[name],issuer)])),preferences_contract:manifest.preferences_contract});
}
const abortCheck=signal=>{if(signal?.aborted)throw coded('canceled','Device authorization was canceled.');};
const combined=(...signals)=>AbortSignal.any(signals.filter(Boolean));
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(coded('canceled'));
 const finish=error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
 const abort=()=>finish(coded('canceled')),timer=setTimeout(()=>finish(),ms);signal?.addEventListener('abort',abort,{once:true});
});
// Abort a confirmation prompt even if the platform adapter ignores its signal.
function confirmAccount(io,account,signal){
 abortCheck(signal);
 return new Promise((resolve,reject)=>{const abort=()=>reject(coded('canceled'));signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>io.confirm(account,{signal})).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
function active(state,flow,signal){abortCheck(signal);if(state.flow!==flow)throw coded('canceled');}
function display(flow){
 if(!flow?.authorization)return null;
 const {user_code:userCode,verification_uri:verificationUri}=flow.authorization,codeLabel=`Sign-in code: ${userCode.replace(/[- ]/g,'').split('').join(' ')}`;
 return Object.freeze({userCode,verificationUri,codeLabel,expiresAt:flow.expiresAt,interval:flow.interval/1000,instructions:'Type or paste the code displayed on this device into the provider page. Approve only a sign-in you started.',text:`To sign in, open ${verificationUri} and enter ${userCode}\nType or paste this code into the provider page. Approve only a sign-in you started.`});
}
export class DeviceAuthorizationDisplay extends Query {
 static operation='sdk.device.display';static deps=['deviceState'];
 fetch({deviceState}){return display(deviceState.flow);}
}
class DeviceAction extends Action {
 static deps=['deviceState','deviceIO'];
 constructor(input={}){super();this.input=input;}
 async execute(resources,context){const result=await this.run(resources,context);context.dispatchFeed.dispatchEvent(new CustomEvent('result',{detail:result}));}
}
async function form(io,url,body,{key,signal,nonces,emptySuccess=false}={}){
  abortCheck(signal);const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
  if(key)headers.DPoP=await io.keys.proof(key,{htu:url,nonce:nonces.get(url),crypto:io.crypto,clock:io.clock});
  abortCheck(signal);
  const response=await io.fetcher(url,{method:'POST',headers,body,credentials:'omit',redirect:'error',signal:combined(signal,AbortSignal.timeout(15000))}),json=response.ok&&emptySuccess?null:await boundedJSON(response).catch(error=>{if([429,503].includes(response.status))return {};throw error;}),nonce=response.headers.get('DPoP-Nonce');
  if(key&&noncePattern.test(nonce??''))nonces.set(url,nonce);
  // Nonce retries are a new proof/attempt; polling applies the interval to them too.
  if(key&&!response.ok&&json?.error==='use_dpop_nonce'&&noncePattern.test(nonce??''))return {response,json,nonceChallenge:true};
  return {response,json};
}
async function revoke(io,token,key,nonces){
 if(!opaque(token?.refresh_token??token?.access_token))return false;
 try{
  const body=new URLSearchParams({client_id:io.clientId,token:token.refresh_token??token.access_token,token_type_hint:token.refresh_token?'refresh_token':'access_token'});
  for(let attempt=0;attempt<2;attempt++){const result=await form(io,io.declaration.revocation_endpoint,body,{key,nonces,emptySuccess:true});if(result.nonceChallenge&&attempt===0)continue;return result.response.ok;}
 }catch{}return false;
}
function validateToken(io,token,key,startedAt,previous){
 if(typeof token?.token_type!=='string'||token.token_type.toLowerCase()!=='dpop'||!opaque(token.access_token)||!opaque(token.refresh_token)||!seconds(token.refresh_idle_expires_in)||!Array.isArray(token.grants)||token.grants.some(grant=>typeof grant!=='string'))throw coded('invalid_token_response','Device credentials must include DPoP access and refresh tokens.');
 try{return validateAccessResponse(token,{issuer:io.issuer,clientId:io.clientId,rpcEndpoint:io.declaration.rpc_endpoint,tokenEndpoint:io.declaration.token_endpoint,preferencesContract:io.declaration.preferences_contract,revocationEndpoint:io.declaration.revocation_endpoint,dpopJkt:key.jkt,clock:io.clock,requestStartedAt:startedAt,previous});}catch{throw coded('invalid_token_response','The provider returned invalid device credentials.');}
}
export class StartDeviceAuthorization extends DeviceAction {
 static operation='sdk.device.start';
 async run({deviceState:state,deviceIO:io},{signal:dispatchSignal}){
  if(state.flow||state.session)throw coded('authorization_in_progress','Cancel the pending flow or revoke the current session first.');
  const {identity,expectedSubject,requests=[],uiLocales,signal}=this.input;
  if(Object.hasOwn(this.input,'scope'))throw coded('invalid_scope','Request fragments instead of scope.');
  if(!Array.isArray(requests)||requests.length>8)throw coded('invalid_request','At most eight fragment requests are allowed.');
  if(identity!==undefined){const parsed=parseIdentity(identity,null);if(parsed.handle!==identity||`https://${parsed.host}`!==io.issuer||!expectedSubject)throw coded('invalid_identity','A complete handle and its trusted expectedSubject are required.');}
  if(expectedSubject!==undefined)endpoint(expectedSubject,io.issuer,{plain:true});
  if(!expectedSubject&&typeof io.confirm!=='function')throw coded('confirmation_required','Provide an account-confirmation callback before signing in.');
  const controller=new AbortController(),flow={controller,nonces:new Map(),polling:false};state.flow=flow;
  try{
   const stopped=combined(signal,dispatchSignal,controller.signal);
   abortCheck(stopped);flow.key=await io.keys.create(io.crypto);active(state,flow,stopped);
   if(!flow.key||await thumbprint(flow.key.jwk,io.crypto)!==flow.key.jkt)throw coded('invalid_dpop_key');
   const body=new URLSearchParams({client_id:io.clientId,dpop_jkt:flow.key.jkt,bindle_requests:JSON.stringify(requests),...identity?{identity}:{},...uiLocales?{ui_locales:uiLocales}:{}});
   if(new TextEncoder().encode(body.toString()).length>8192)throw coded('invalid_request','Device requests are limited to 8 KiB.');
   const startedAt=io.clock(),{response,json}=await form(io,io.declaration.device_authorization_endpoint,body,{signal:stopped});active(state,flow,stopped);
   if(!response.ok)throw coded(opaque(json?.error)?json.error:'device_authorization_failed');
   if(!opaque(json?.device_code)||typeof json.user_code!=='string'||!/^[A-Za-z0-9]+(?:[- ][A-Za-z0-9]+)*$/.test(json.user_code)||json.user_code.length>64||!seconds(json.expires_in)||json.expires_in>600||!seconds(json.interval)||json.interval<5)throw coded('invalid_device_response');
   endpoint(json.verification_uri,io.issuer,{plain:true});if(json.verification_uri_complete!==undefined){const complete=new URL(json.verification_uri_complete);complete.hash='';endpoint(complete.href,io.issuer);}
   flow.authorization={device_code:json.device_code,user_code:json.user_code,verification_uri:json.verification_uri};flow.expiresAt=startedAt+json.expires_in*1000;flow.interval=json.interval*1000;flow.nextPoll=io.clock()+flow.interval;flow.expectedSubject=expectedSubject;
   // Keep the caller's lifetime signal through polling, not just the first POST.
   flow.signal=stopped;return display(flow);
  }catch(error){if(state.flow===flow)state.flow=null;controller.abort();throw error;}
 }
}
export class PollDeviceAuthorization extends DeviceAction {
 static operation='sdk.device.poll';
 async run({deviceState:state,deviceIO:io},{signal:dispatchSignal}){
  const flow=state.flow;if(!flow?.authorization)throw coded('no_device_authorization');if(flow.polling)throw coded('polling_in_progress');flow.polling=true;
  let issued;
  try{
   const signal=combined(flow.signal,this.input.signal,dispatchSignal),body=new URLSearchParams({grant_type:deviceGrant,client_id:io.clientId,device_code:flow.authorization.device_code});
   for(;;){
    active(state,flow,signal);if(io.clock()>=flow.expiresAt)throw coded('expired_token','The sign-in code expired. Start a new flow.');
    await io.sleep(Math.max(0,Math.min(flow.nextPoll,flow.expiresAt)-io.clock()),signal);active(state,flow,signal);
    if(io.clock()>=flow.expiresAt)throw coded('expired_token');
    const startedAt=io.clock(),{response,json,nonceChallenge}=await form(io,io.declaration.token_endpoint,body,{key:flow.key,nonces:flow.nonces,signal});
    if(response.ok)issued=json;active(state,flow,signal);
    flow.nextPoll=io.clock()+flow.interval;
    if(!response.ok){
     if(response.status===429||response.status===503){const retry=response.headers.get('Retry-After'),date=Date.parse(retry),delay=/^[0-9]{1,9}$/.test(retry??'')?Number(retry)*1000:Number.isFinite(date)?Math.max(0,date-io.clock()):0;flow.interval=Math.min(60000,flow.interval*2);flow.nextPoll=io.clock()+Math.max(flow.interval,delay);flow.nonceRetried=false;continue;}
     if(json?.error==='authorization_pending'){flow.nonceRetried=false;continue;}
     if(json?.error==='slow_down'){flow.nonceRetried=false;flow.interval=Math.max(flow.interval+5000,seconds(json.interval)?json.interval*1000:0);flow.nextPoll=io.clock()+flow.interval;continue;}
     if(nonceChallenge&&!flow.nonceRetried){flow.nonceRetried=true;continue;}
     throw coded(opaque(json?.error)?json.error:'device_authorization_failed');
    }
    const token=validateToken(io,json,flow.key,startedAt);
    if(flow.expectedSubject&&token.subject!==flow.expectedSubject)throw coded('subject_mismatch','The approved account does not match the requested account.');
    if(!flow.expectedSubject&&await confirmAccount(io,Object.freeze({issuer:token.issuer,subject:token.subject,expiresAt:token.expiresAt,refreshExpiresAt:token.refreshExpiresAt}),signal)!==true)throw coded('access_denied','The signed-in account was not confirmed.');
    active(state,flow,signal);state.session={token,key:flow.key,nonces:flow.nonces};state.flow=null;return token;
   }
  }catch(error){if(issued)await revoke(io,issued,flow.key,flow.nonces);throw error;}
  finally{if(state.flow===flow)state.flow=null;flow.controller.abort();}
 }
}
export class CancelDeviceAuthorization extends DeviceAction {
 static operation='sdk.device.cancel';
 run({deviceState:state}){const flow=state.flow;state.flow=null;flow?.controller.abort();return !!flow;}
}
export class RefreshDeviceSession extends DeviceAction {
 static operation='sdk.device.refresh';
 async run({deviceState:state,deviceIO:io},{signal:dispatchSignal}){
  const session=state.session;if(!session)throw coded('sign_in_required');if(session.refreshing)throw coded('refresh_in_progress');session.refreshing=true;
  let issued;
  try{
   if(io.clock()>=session.token.refreshExpiresAt)throw coded('invalid_grant');
   const signal=combined(this.input.signal,dispatchSignal),body=new URLSearchParams({grant_type:'refresh_token',refresh_token:session.token.refresh_token,client_id:io.clientId}),startedAt=io.clock();let result;
   for(let attempt=0;attempt<2;attempt++){result=await form(io,io.declaration.token_endpoint,body,{key:session.key,nonces:session.nonces,signal});if(result.nonceChallenge&&attempt===0)continue;break;}
   if(!result.response.ok)throw coded(opaque(result.json?.error)?result.json.error:'refresh_failed');issued=result.json;
   if(state.session!==session)throw coded('canceled');abortCheck(signal);
   const token=validateToken(io,issued,session.key,startedAt,session.token);session.token=token;return token;
  }catch(error){if(state.session===session)state.session=null;if(issued)await revoke(io,issued,session.key,session.nonces);throw error;}
  finally{session.refreshing=false;}
 }
}
export class DeviceResourceRequest extends DeviceAction {
 static operation='sdk.device.request';
 async run({deviceState:state,deviceIO:io},{signal:dispatchSignal}){
  const session=state.session;if(!session||io.clock()>=session.token.expiresAt||io.clock()>=session.token.refreshExpiresAt)throw coded('sign_in_required');
  const {body,signal}=this.input,url=io.declaration.rpc_endpoint,token=session.token;
  // Resource writes are never retried automatically, including nonce challenges.
  const proof=await io.keys.proof(session.key,{htu:url,accessToken:token.access_token,nonce:session.nonces.get(url),crypto:io.crypto,clock:io.clock});
  if(state.session!==session||session.token!==token)throw coded('canceled');abortCheck(signal);abortCheck(dispatchSignal);
  const response=await io.fetcher(url,{method:'POST',credentials:'omit',redirect:'error',signal:combined(signal,dispatchSignal,AbortSignal.timeout(15000)),headers:{'Content-Type':'application/json',Accept:'application/json',Authorization:`DPoP ${token.access_token}`,DPoP:proof},body:JSON.stringify(body)}),nonce=response.headers.get('DPoP-Nonce');
  if(noncePattern.test(nonce??''))session.nonces.set(url,nonce);return {response,result:await boundedJSON(response)};
 }
}
export class RevokeDeviceSession extends DeviceAction {
 static operation='sdk.device.revoke';
 async run({deviceState:state,deviceIO:io}){const session=state.session;state.session=null;return session?revoke(io,session.token,session.key,session.nonces):false;}
}
export const DEVICE_OPERATIONS=Object.freeze([StartDeviceAuthorization,PollDeviceAuthorization,CancelDeviceAuthorization,RefreshDeviceSession,DeviceResourceRequest,RevokeDeviceSession,DeviceAuthorizationDisplay]);

/** Platform effects are injectable. An OS-keystore adapter supplies keys.create
 * and keys.proof with an opaque key handle, public jwk and RFC 7638 jkt. Default
 * keys are non-extractable WebCrypto keys; tokens and keys stay memory-only.
 * `identity` needs its independently trusted expectedSubject (subjects are opaque,
 * not derived from handles). Otherwise confirm(account,{signal}) must return true.
 */
export function createDeviceEngine({issuer,manifest,clientId,fetcher,crypto=globalThis.crypto,clock=Date.now,sleep:wait=sleep,keys={create:createKey,proof:createProof},confirm}={}){
 if(typeof globalThis.document!=='undefined')throw coded('browser_not_supported','Device authorization is for non-browser clients.');
 if(!opaque(clientId)||clientId.length>2048)throw coded('invalid_client');
 // Node fetch injects Sec-Fetch-Mode, which this profile forbids at the server.
 if(typeof fetcher!=='function')throw coded('invalid_transport','Supply a non-browser transport that sends no Origin or Sec-Fetch-* headers.');
 const declaration=deviceDeclaration(manifest,issuer),state={flow:null,session:null},io={issuer,declaration,clientId,fetcher,crypto,clock,sleep:wait,keys,confirm};
 return new Engine({providers:{deviceState:Provider.fromSingleton(state),deviceIO:Provider.fromSingleton(io)}});
}
async function perform(engine,action){const feed=engine.dispatch(action);let result;feed.addEventListener('result',event=>{result=event.detail;},{once:true});await feed.next('complete');return result;}
/** Thin facade; tests can drive the same exported Actions/Query through engine. */
export class BindleDeviceClient {
 constructor(options){this.engine=createDeviceEngine(options);}
 start(input){return perform(this.engine,new StartDeviceAuthorization(input));}
 poll(input){return perform(this.engine,new PollDeviceAuthorization(input));}
 display(){return this.engine.query(new DeviceAuthorizationDisplay()).peek();}
 cancel(){return perform(this.engine,new CancelDeviceAuthorization());}
 refresh(input){return perform(this.engine,new RefreshDeviceSession(input));}
 request(body,{signal}={}){return perform(this.engine,new DeviceResourceRequest({body,signal}));}
 revoke(){return perform(this.engine,new RevokeDeviceSession());}
 async dispose(){await this.cancel();await this.revoke();await this.engine.dispose();}
}
export const createDeviceClient=options=>new BindleDeviceClient(options);

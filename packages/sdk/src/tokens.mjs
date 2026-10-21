// Token endpoint, revocation and RPC transport for BindleClient, loaded on first
// use so the element bundle stays small. Every function takes the client; the
// synchronous parts (generations, single-flight refresh) stay in identity.mjs.
import {createProof} from './dpop.mjs';

const coded=(message,code)=>Object.assign(new Error(message),{code});
const nonceValue=/^[\x21-\x7e]{1,512}$/;
// Refresh credentials last for the issued token's idle window; only key-bound ones may persist.
export const refreshLimits=Object.freeze({memory:31536000,bound:31536000});

export async function boundedJSON(response){
  const type=response.headers.get('Content-Type')??'';if(!type.toLowerCase().includes('application/json'))throw new Error('Provider response must be JSON.');
  if(Number(response.headers.get('Content-Length'))>1500000)throw new Error('Provider response is too large.');
  let text;if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1500000){await reader.cancel();throw new Error('Provider response is too large.');}chunks.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}else text=await response.text();
  if(new TextEncoder().encode(text).length>1500000)throw new Error('Provider response is too large.');return JSON.parse(text);
}
export function deepFreeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}
const signalFor=signal=>signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);

// One token-endpoint request. With a DPoP key it signs a fresh proof per attempt
// and retries once when the provider asks for a nonce (RFC 9449 §8); a proof
// failure never consumes the code or refresh token on a conforming provider.
async function tokenRequest(client,{endpoint,issuer,body,key,signal}){
  for(let attempt=0;;attempt++){
    const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
    if(key)headers.DPoP=await createProof(key,{htu:endpoint,nonce:client.dpopNonces.get(endpoint),crypto:client.crypto,clock:client.clock});
    const response=await client.fetcher(endpoint,{method:'POST',credentials:'omit',redirect:'error',signal,headers,body});
    const nonce=response.headers?.get?.('DPoP-Nonce');// Nonces are cached per endpoint: providers may scope them to one purpose.
    if(key&&nonceValue.test(nonce??''))client.dpopNonces.set(endpoint,nonce);
    const json=await boundedJSON(response);
    if(key&&!response.ok&&json?.error==='use_dpop_nonce'&&nonce&&attempt===0)continue;
    if(key&&!response.ok&&json?.error==='invalid_dpop_proof')client.capabilities.degrade(issuer,'dpop');
    return {response,json};
  }
}

export function validateAccessResponse(token,{issuer,clientId,rpcEndpoint,tokenEndpoint,preferencesContract,revocationEndpoint,dpopJkt,clock,requestStartedAt=clock(),previous}) {
  const type=typeof token?.token_type==='string'?token.token_type.toLowerCase():'';
  // Bearer access tokens are accepted on every session; DPoP-typed ones only when this exchange proved a key.
  if(!token||token.issuer!==issuer||token.client_id!==clientId||!(type==='bearer'||type==='dpop'&&dpopJkt)||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>8192||!Number.isSafeInteger(token.expires_in)||token.expires_in<=0||token.expires_in>(type==='dpop'?3600:900)||token.audience!==rpcEndpoint||typeof token.subject!=='string'||token.subject.length>2048||!Array.isArray(token.granted_fragments)||token.granted_fragments.length>8)throw new Error('Provider returned an invalid access token response.');
  // Any HTTPS identity URL on the issuer origin; the path shape belongs to the provider.
  let subject;try{subject=new URL(token.subject);}catch{throw new Error('Provider returned an invalid identity subject.');}
  if(subject.origin!==issuer||subject.href!==token.subject||subject.search||subject.hash||subject.username||subject.password)throw new Error('Provider returned an invalid identity subject.');
  const idle=token.refresh_idle_expires_in,limit=dpopJkt?refreshLimits.bound:refreshLimits.memory;
  if(token.refresh_token!==undefined&&(typeof token.refresh_token!=='string'||!token.refresh_token||token.refresh_token.length>8192||!Number.isSafeInteger(token.refresh_expires_in)||token.refresh_expires_in<=0||token.refresh_expires_in>limit||token.expires_in>token.refresh_expires_in||idle!==undefined&&(!Number.isSafeInteger(idle)||idle<=0||idle>token.refresh_expires_in)))throw new Error('Provider returned an invalid session renewal credential.');
  for(const grant of token.granted_fragments)if(!grant||typeof grant.grant!=='string'||typeof grant.fragment!=='string'||typeof grant.digest!=='string'||!Array.isArray(grant.fields)||grant.fields.some(field=>typeof field!=='string')||new Set(grant.fields).size!==grant.fields.length)throw new Error('Provider returned invalid fragment grants.');
  if(previous){
    if(token.subject!==previous.subject||!token.refresh_token||token.refresh_token===previous.refresh_token)throw new Error('Provider changed the renewed session identity or reused its credential.');
    for(const grant of token.granted_fragments){const prior=previous.granted_fragments.find(item=>item.grant===grant.grant);if(!prior||prior.fragment!==grant.fragment||prior.digest!==grant.digest||grant.fields.some(field=>!prior.fields.includes(field)))throw new Error('Session renewal attempted to expand its approved grants.');}
    if(Array.isArray(token.grants)&&token.grants.some(grant=>!previous.grants?.includes(grant)))throw new Error('Session renewal attempted to expand its approved grants.');
  }
  // Each rotation issues a fresh credential. Its deadline can move later (auth.md);
  // anchor to request start so response transit never extends the advertised lifetime.
  const refreshExpiresAt=token.refresh_token?requestStartedAt+Math.min(token.refresh_expires_in,idle??Infinity)*1000:undefined;
  return deepFreeze({...token,tokenType:type==='dpop'?'DPoP':'Bearer',clientId,...dpopJkt?{dpopJkt}:{},rpcEndpoint,tokenEndpoint,preferencesContract,...revocationEndpoint?{revocationEndpoint}:{},expiresAt:Math.min(requestStartedAt+token.expires_in*1000,refreshExpiresAt??Infinity),renewalCount:previous?(previous.renewalCount??0)+1:0,...refreshExpiresAt?{refreshExpiresAt}:{}});
}

// Exchanges a code that was already validated against its pending record.
export async function redeem(client,pending,code,{signal,generation}){
  for(const endpoint of[pending.tokenEndpoint,pending.rpcEndpoint,...pending.revocationEndpoint?[pending.revocationEndpoint]:[]])if(new URL(endpoint).origin!==pending.issuer)throw coded('Stored provider endpoints do not match the issuer.','invalid-callback');
  const key=pending.dpopJkt?await client.dpopKey(pending.dpopJkt):null;
  if(pending.dpopJkt&&!key)throw coded('This sign-in can no longer be completed. Try again.','invalid-callback');
  const requestStartedAt=client.clock(),body=new URLSearchParams({grant_type:'authorization_code',code,code_verifier:pending.verifier,client_id:pending.clientId,redirect_uri:pending.redirectUri});
  let response,token;
  try{({response,json:token}=await tokenRequest(client,{endpoint:pending.tokenEndpoint,issuer:pending.issuer,body,key,signal:signalFor(signal)}));}catch(error){if(signal?.aborted)throw error;throw coded(error?.message??'The authorization code could not be exchanged.','network-error');}
  if(!response.ok)throw coded(typeof token?.message==='string'?token.message:'The authorization code could not be exchanged.','network-error');
  // The code is already redeemed: tokens issued for a canceled login are revoked, not dropped live.
  if(generation!==client.loginGeneration){if(typeof token?.access_token==='string')revoke(client,{...token,client_id:pending.clientId,issuer:pending.issuer,revocationEndpoint:pending.revocationEndpoint}).catch(()=>{});throw coded('Login was canceled.','canceled');}
  // auth_time is meaningful only for reauthentication; elsewhere it would reveal
  // whether the user had to sign in first, so it is never kept (EE-02).
  const {auth_time:authTime,...rest}=token;
  const validated=validateAccessResponse(pending.intent==='reauthenticate'?{...rest,auth_time:authTime}:rest,{...pending,dpopJkt:key?pending.dpopJkt:undefined,clock:client.clock,requestStartedAt});
  if(pending.intent==='reauthenticate'){
    const current=client.session;
    if(!current||validated.subject!==pending.subjectConstraint||current.subject!==pending.subjectConstraint||current.issuer!==validated.issuer||!Number.isSafeInteger(authTime)||authTime*1000<client.clock()-pending.maxAge*1000||authTime*1000>client.clock()+60000){
      revoke(client,validated).catch(()=>{});
      throw coded('Reauthentication did not confirm the current account.','canceled');
    }
  }
  return validated;
}

export async function renew(client,session,signal){
  const key=session.dpopJkt?await client.dpopKey(session.dpopJkt):null;
  if(session.dpopJkt&&!key)throw new Error('This application session could not be renewed. Sign in again.');
  const requestStartedAt=client.clock(),body=new URLSearchParams({grant_type:'refresh_token',refresh_token:session.refresh_token,client_id:session.client_id});
  const {response,json:token}=await tokenRequest(client,{endpoint:session.tokenEndpoint,issuer:session.issuer,body,key,signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
  if(!response.ok)throw new Error('This application session could not be renewed. Sign in again.');
  const {auth_time:_ignored,...rest}=token;
  return validateAccessResponse(rest,{issuer:session.issuer,clientId:session.client_id,rpcEndpoint:session.rpcEndpoint,tokenEndpoint:session.tokenEndpoint,preferencesContract:session.preferencesContract,revocationEndpoint:session.revocationEndpoint,dpopJkt:session.dpopJkt,clock:client.clock,requestStartedAt,previous:session});
}

// RFC 7009 revocation of exactly one app session: its own refresh token (which
// cascades to that session's family and paired component credential), else its
// access token. Returns false when the provider advertises no endpoint.
export async function revoke(client,session,{signal}={}){
  if(!session?.revocationEndpoint||new URL(session.revocationEndpoint).origin!==session.issuer)return false;
  const token=session.refresh_token??session.access_token;
  const response=await client.fetcher(session.revocationEndpoint,{method:'POST',credentials:'omit',redirect:'error',signal:signalFor(signal),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,token_type_hint:session.refresh_token?'refresh_token':'access_token',client_id:session.client_id})});
  return response.ok;
}

// One RPC request. A DPoP-typed access token is sent with a fresh proof bound to
// it (`ath`); scoped resource tokens are always Bearer.
export async function sendRPC(client,session,body,{signal,token}){
  const dpop=!token&&session.tokenType==='DPoP',key=dpop?await client.dpopKey(session.dpopJkt):null;
  if(dpop&&!key)throw new Error('Sign in again before accessing this resource.');
  for(let attempt=0;;attempt++){
    const headers={'Content-Type':'application/json',Accept:'application/json',Authorization:`${dpop?'DPoP':'Bearer'} ${token??session.access_token}`};
    if(dpop)headers.DPoP=await createProof(key,{htu:session.rpcEndpoint,nonce:client.dpopNonces.get(session.rpcEndpoint),accessToken:session.access_token,crypto:client.crypto,clock:client.clock});
    const response=await client.fetcher(session.rpcEndpoint,{method:'POST',credentials:'omit',redirect:'error',signal:signalFor(signal),headers,body});
    const nonce=response.headers?.get?.('DPoP-Nonce');
    if(dpop&&nonceValue.test(nonce??'')){client.dpopNonces.set(session.rpcEndpoint,nonce);if(response.status===401&&attempt===0&&/use_dpop_nonce/.test(response.headers.get('WWW-Authenticate')??''))continue;}
    return {response,result:await boundedJSON(response)};
  }
}

export async function callResource(client,reference,call,options,{before,provenance,generation}){
  const resource=new URL(reference.id);
  if(!before||resource.origin!==before.issuer||resource.username||resource.password||resource.hash)throw new Error('The resource belongs to a different identity provider.');
  const session=await client.ensureSession(options);
  if(generation!==client.generation)throw new Error('Resource access was canceled.');
  if(provenance&&(provenance.generation!==generation||provenance.subject!==session.subject||provenance.issuer!==session.issuer||provenance.id!==reference.id||provenance.token!==reference.token))throw new Error('Read the preference fragment again before using this resource.');
  if(provenance?.accessToken!==session.access_token&&provenance){
    const preferences=await client.readPreferences(provenance.fragment,options),value=preferences.values[provenance.field],list=Array.isArray(value)?value:[value];
    const renewed=list.find(item=>item?.id===provenance.id);
    if(!renewed)throw new Error('This resource assignment changed. Read the preference fragment again.');
    reference=renewed;
  } else if(!provenance&&(before.access_token!==session.access_token||session.renewalCount>0))throw new Error('This resource credential expired. Read the preference fragment again.');
  return client.rpc({...call,resource:reference.id},{...options,token:reference.token});
}

export async function readPreferences(client,fragment,options){
  await client.ensureSession(options);
  const generation=client.generation,session=client.session,result=(await client.rpc({resource:'@preferences',contract:session.preferencesContract,method:'read',args:{fragment}},options)).result;
  if(generation!==client.generation||client.session?.subject!==session.subject)throw new Error('Resource access was canceled.');
  for(const[field,value]of Object.entries(result.values??{}))for(const ref of Array.isArray(value)?value:[value])if(ref&&typeof ref==='object'&&typeof ref.id==='string'&&typeof ref.token==='string')client.references.set(ref,{fragment,field,id:ref.id,issuer:session.issuer,subject:session.subject,generation,accessToken:session.access_token,token:ref.token});
  for(const value of Object.values(result.values??{}))for(const ref of Array.isArray(value)?value:[value])if(ref&&typeof ref==='object'&&client.references.has(ref))deepFreeze(ref);
  return result;
}

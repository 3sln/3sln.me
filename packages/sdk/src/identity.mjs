export function parseIdentity(value, defaultHost = '3sln.me', {allowInsecureLocalhost=false}={}) {
  const raw = value.trim();
  const handle = raw.includes('@') ? raw : `${raw}@${defaultHost}`;
  const parts = handle.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || /[\s\x00-\x1f\x7f/?#\\]/.test(handle)||parts[0]?.includes(':')||!allowInsecureLocalhost&&handle.includes(':')) throw new Error('Enter a handle like alex@provider.example.');
  const local=allowInsecureLocalhost&&/^localhost(?::[0-9]{1,5})?$/.test(parts[1]);
  if(!local&&parts[1].includes(':'))throw new Error('Use a complete provider hostname.');
  const parsed=new URL(`${local?'http':'https'}://${parts[1]}`),host=local?parsed.host:parsed.hostname;
  if (!local&&(/^\d+(\.\d+){3}$/.test(host) || !host.includes('.') || host.length > 253 || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)))) throw new Error('Use a complete provider hostname.');
  return { handle: `${parts[0]}@${host}`, username: parts[0], host, manifestUrl: `${local?'http':'https'}://${host}/.well-known/bindle/manifest.json` };
}
export async function discoverIdentity(value, { fetcher = fetch, signal, allowInsecureLocalhost=false } = {}) {
  const identity = parseIdentity(value,'3sln.me',{allowInsecureLocalhost});
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
  const response = await fetcher(identity.manifestUrl, { signal: boundedSignal, credentials: 'omit', redirect: 'error', referrerPolicy:'no-referrer', headers: { Accept: 'application/json' } });
  // Only a definite absence allows fallback. Network failures must not silently switch providers.
  if (response.status === 404 || response.status === 410) return { identity, kind: 'email-fallback', provider: 'https://3sln.me' };
  if (!response.ok) throw new Error(`Provider discovery failed (${response.status}).`);
  if (!response.headers?.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('Provider manifest must be JSON.');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) { await reader.cancel(); throw new Error('Provider manifest is too large.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    text = new TextDecoder().decode(joined);
  } else text = await response.text();
  if (new TextEncoder().encode(text).length > 65536) throw new Error('Provider manifest is too large.');
  const manifest = JSON.parse(text);
  const issuer = new URL(identity.manifestUrl).origin;
  if (!manifest || manifest.version !== '0' || manifest.issuer !== issuer) throw new Error('Unsupported manifest version or mismatched issuer.');
  if (!Array.isArray(manifest.login_presentation) || !manifest.login_presentation.includes('redirect')) throw new Error('Provider must support redirect login.');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'rpc_endpoint', 'jwks_uri','authorization_request_endpoint']) {
    if (typeof manifest[key] !== 'string') throw new Error(`Missing provider endpoint: ${key}.`);
    const endpoint = new URL(manifest[key]);
    if (endpoint.origin !== issuer || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Provider endpoints must belong to the issuer origin.');
  }
  if(typeof manifest.preferences_contract!=='string')throw new Error('Missing preferences contract.');const preferenceContract=new URL(manifest.preferences_contract);if(preferenceContract.protocol!=='https:'||preferenceContract.username||preferenceContract.password||preferenceContract.hash)throw new Error('Invalid preferences contract.');
  const login = new URL(manifest.authorization_endpoint);
  return { identity, kind: 'provider', manifest, loginUrl: login.href, presentation: 'redirect' };
}

const encode64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomSecret = crypto => encode64(crypto.getRandomValues(new Uint8Array(32)));
export class BindleClient {
  constructor({clientId,redirectUri,fetcher=globalThis.fetch.bind(globalThis),crypto=globalThis.crypto,storage=globalThis.sessionStorage,storageKey='bindle.pending-login',clock=Date.now,allowInsecureLocalhost=false,history=globalThis.history}={}) {
    const callback=new URL(redirectUri);
    if(!clientId||callback.hash||callback.username||callback.password||!['https:','http:'].includes(callback.protocol)||callback.protocol==='http:'&&!['localhost','127.0.0.1'].includes(callback.hostname))throw new Error('A client ID and secure callback URL are required.');
    this.clientId=clientId;this.redirectUri=callback.href;this.fetcher=fetcher;this.crypto=crypto;this.storage=storage;this.storageKey=storageKey;this.clock=clock;this.generation=0;this.history=history;this.session=null;this.refreshPromise=null;this.refreshController=null;this.references=new WeakMap();this.allowInsecureLocalhost=allowInsecureLocalhost;
  }
  async beginLogin(identity,{requests=[],signal}={}) {
    this.cancelLogin();const generation=this.generation;
    const discovered=await discoverIdentity(identity,{fetcher:this.fetcher,signal,allowInsecureLocalhost:this.allowInsecureLocalhost});
    if(generation!==this.generation)throw new Error('Login was canceled.');
    if(discovered.kind!=='provider')return discovered;
    const manifest=discovered.manifest,issuer=manifest.issuer;
    const endpoint=new URL(manifest.authorization_request_endpoint,issuer);
    if(endpoint.origin!==issuer||endpoint.username||endpoint.password||endpoint.hash)throw new Error('Invalid authorization request endpoint.');
    const verifier=randomSecret(this.crypto),state=randomSecret(this.crypto),challenge=encode64(new Uint8Array(await this.crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    const response=await this.fetcher(endpoint.href,{method:'POST',credentials:'omit',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({clientId:this.clientId,redirectUri:this.redirectUri,challenge,challengeMethod:'S256',state,requests,identity:discovered.identity.handle})});
    const result=await boundedJSON(response);
    if(!response.ok)throw new Error(result.message??'Could not start provider authorization.');
    if(!/^(?:[0-9a-f-]{36}\.)?[A-Za-z0-9_-]{43}$/.test(result.requestId))throw new Error('Provider returned an invalid request identifier.');
    const authorize=new URL(manifest.authorization_endpoint);authorize.searchParams.set('request_id',result.requestId);
    if(generation!==this.generation)throw new Error('Login was canceled.');
    this.storage.setItem(this.storageKey,JSON.stringify({verifier,state,issuer,tokenEndpoint:manifest.token_endpoint,rpcEndpoint:manifest.rpc_endpoint,preferencesContract:manifest.preferences_contract,clientId:this.clientId,redirectUri:this.redirectUri,expiresAt:this.clock()+600000}));
    return {...discovered,authorizationUrl:authorize.href};
  }
  cancelLogin(){this.generation++;this.storage.removeItem(this.storageKey);if(this.refreshController){this.refreshController.abort();this.refreshController=null;this.refreshPromise=null;this.session=null;}}
  async completeLogin(callbackUrl=globalThis.location?.href,{signal}={}) {
    const serialized=this.storage.getItem(this.storageKey);if(!serialized)throw new Error('There is no pending Bindle login.');
    const pending=JSON.parse(serialized),callback=new URL(callbackUrl),expected=new URL(this.redirectUri);
    if(callback.username||callback.password||callback.origin!==expected.origin||callback.pathname!==expected.pathname||callback.hash||pending.clientId!==this.clientId||pending.redirectUri!==this.redirectUri||pending.expiresAt<=this.clock())throw new Error('This login callback is invalid or expired.');
    const expectedParams=[...expected.searchParams];for(const[k,v]of expectedParams)if(callback.searchParams.getAll(k).length!==1||callback.searchParams.get(k)!==v)throw new Error('The callback URL does not match the registered callback.');
    const allowed=new Set([...expected.searchParams.keys(),'code','state','iss','error','error_description']);
    if([...callback.searchParams.keys()].some(k=>!allowed.has(k)||callback.searchParams.getAll(k).length!==1)||callback.searchParams.get('state')!==pending.state||callback.searchParams.get('iss')!==pending.issuer)throw new Error('This login callback does not match the pending request.');
    // Consume before exchanging: replay or uncertain network failures require a fresh login.
    this.cancelLogin();const generation=this.generation;
    if(globalThis.location?.origin===callback.origin&&globalThis.location?.pathname===callback.pathname)this.history?.replaceState(null,'',expected.pathname+expected.search);
    if(callback.searchParams.has('error'))throw new Error('The application connection was declined or could not be completed.');
    const code=callback.searchParams.get('code');if(!/^(?:[0-9a-f-]{36}\.)?[A-Za-z0-9_-]{43}$/.test(code??''))throw new Error('The callback does not contain a valid authorization code.');
    for(const endpoint of[pending.tokenEndpoint,pending.rpcEndpoint])if(new URL(endpoint).origin!==pending.issuer)throw new Error('Stored provider endpoints do not match the issuer.');
    const requestStartedAt=this.clock(),body=new URLSearchParams({grant_type:'authorization_code',code,code_verifier:pending.verifier,client_id:this.clientId,redirect_uri:this.redirectUri});
    const response=await this.fetcher(pending.tokenEndpoint,{method:'POST',credentials:'omit',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body});const token=await boundedJSON(response);
    if(!response.ok)throw new Error(token.message??'The authorization code could not be exchanged.');
    if(generation!==this.generation)throw new Error('Login was canceled.');
    this.session=validateAccessResponse(token,{...pending,clock:this.clock,requestStartedAt});return this.session;
  }
  async refresh({signal}={}) {
    if(signal?.aborted)throw new DOMException('The operation was canceled.','AbortError');
    if(this.refreshPromise)return waitForRefresh(this.refreshPromise,signal);
    const generation=this.generation,session=this.session;
    if(!session?.refresh_token||session.refreshExpiresAt<=this.clock())throw new Error('Sign in again to renew this application session.');
    const controller=new AbortController();this.refreshController=controller;
    const promise=(async()=>{
      try {
        const requestStartedAt=this.clock(),body=new URLSearchParams({grant_type:'refresh_token',refresh_token:session.refresh_token,client_id:this.clientId});
        const response=await this.fetcher(session.tokenEndpoint,{method:'POST',credentials:'omit',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body});
        const token=await boundedJSON(response);
        if(!response.ok)throw new Error('This application session could not be renewed. Sign in again.');
        const renewed=validateAccessResponse(token,{issuer:session.issuer,clientId:this.clientId,rpcEndpoint:session.rpcEndpoint,tokenEndpoint:session.tokenEndpoint,preferencesContract:session.preferencesContract,clock:this.clock,requestStartedAt,previous:session});
        if(generation!==this.generation||this.session!==session)throw new Error('Session renewal was canceled.');
        this.session=renewed;return renewed;
      } catch(error) {
        // Rotation may have reached the provider even if its response was lost.
        // Never replay the previous refresh token or wipe a newer login.
        if(generation===this.generation&&this.session===session)this.session=null;
        throw error;
      }
    })();
    this.refreshPromise=promise;
    const cleanup=()=>{if(this.refreshPromise===promise)this.refreshPromise=null;if(this.refreshController===controller)this.refreshController=null;};promise.then(cleanup,cleanup);return waitForRefresh(promise,signal);
  }
  async ensureSession(options={}) {
    if(options.signal?.aborted)throw new DOMException('The operation was canceled.','AbortError');
    const session=this.session;
    if(!session)throw new Error('Sign in again before accessing this resource.');
    if(session.expiresAt-this.clock()<=30000){if(session.refresh_token)return this.refresh(options);if(session.expiresAt<=this.clock())throw new Error('Sign in again before accessing this resource.');}
    return session;
  }
  async rpc({resource,contract,method,args={},tx=this.crypto.randomUUID()},{signal,token}={}) {
    const generation=this.generation,session=await this.ensureSession({signal});
    if(generation!==this.generation)throw new Error('Resource access was canceled.');
    const response=await this.fetcher(session.rpcEndpoint,{method:'POST',credentials:'omit',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json',Authorization:`Bearer ${token??session.access_token}`},body:JSON.stringify({version:'0',tx,resource,contract,method,args})});const result=await boundedJSON(response);
    if(generation!==this.generation||this.session?.subject!==session.subject||this.session?.issuer!==session.issuer)throw new Error('Resource access was canceled.');if(!response.ok)throw new Error(result.message??'The resource request was denied.');if(result.version!=='0'||result.tx!==tx)throw new Error('Provider returned a mismatched RPC response.');if(result.error){const error=new Error(typeof result.error.message==='string'?result.error.message:'The resource request failed.');if(typeof result.error.code==='string'&&/^[a-zA-Z0-9_.-]{1,64}$/.test(result.error.code))error.code=result.error.code;if(Number.isInteger(result.error.retryAfter)&&result.error.retryAfter>=0&&result.error.retryAfter<=86400)error.retryAfter=result.error.retryAfter;throw error;}return result;
  }
  async callResource(reference,call,options={}) {
    if(!reference||typeof reference.id!=='string'||typeof reference.token!=='string')throw new Error('A scoped resource reference is required.');
    const resource=new URL(reference.id),before=this.session,provenance=this.references.get(reference),generation=this.generation;
    if(!before||resource.origin!==before.issuer||resource.username||resource.password||resource.hash)throw new Error('The resource belongs to a different identity provider.');
    const session=await this.ensureSession(options);
    if(generation!==this.generation)throw new Error('Resource access was canceled.');
    if(provenance&&(provenance.generation!==generation||provenance.subject!==session.subject||provenance.issuer!==session.issuer||provenance.id!==reference.id||provenance.token!==reference.token))throw new Error('Read the preference fragment again before using this resource.');
    if(provenance?.accessToken!==session.access_token&&provenance){
      const preferences=await this.readPreferences(provenance.fragment,options),value=preferences.values[provenance.field],list=Array.isArray(value)?value:[value];
      const renewed=list.find(item=>item?.id===provenance.id);
      if(!renewed)throw new Error('This resource assignment changed. Read the preference fragment again.');
      reference=renewed;
    } else if(!provenance&&(before.access_token!==session.access_token||session.renewalCount>0))throw new Error('This resource credential expired. Read the preference fragment again.');
    return this.rpc({...call,resource:reference.id},{...options,token:reference.token});
  }
  async userMessage(reference,message={},options={}) {
    if(!message||Array.isArray(message)||typeof message!=='object'||Object.keys(message).some(key=>!['subject','body','mimeType','tags','transactionId','createdAt'].includes(key)))throw new Error('Unsupported app message fields.');
    const {subject,body,mimeType='text/plain',tags=[],transactionId=this.crypto.randomUUID(),createdAt=this.clock()}=message;
    // The host page, not a caller-supplied origin, determines browser provenance.
    const actual=globalThis.window?.location?.origin,realm=globalThis.window?.origin;
    if(!actual||realm!==actual||actual!==new URL(this.redirectUri).origin)throw new Error('App messages must originate from the registered app origin.');
    if(typeof subject!=='string'||!subject.trim()||[...subject].length>120||typeof body!=='string'||[...body].length>12000||new TextEncoder().encode(JSON.stringify({transactionId,createdAt,subject,mimeType,body,tags})).length>16384||!['text/plain','text/html'].includes(mimeType)||!Array.isArray(tags)||tags.length>31||new Set(tags).size!==tags.length||tags.some(tag=>typeof tag!=='string'||!tag||[...tag].length>64||/[\x00-\x1f\x7f]/.test(tag)||tag==='app-message')||!Number.isSafeInteger(createdAt)||createdAt<0||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transactionId))throw new Error('Provide a bounded app message and a valid transaction ID.');
    try{const response=await this.callResource(reference,{contract:'https://3sln.me/artefacts/contracts/app-messages/v1',method:'createOwn',args:{transactionId,createdAt,subject,mimeType,body,tags},tx:transactionId},options);return {transactionId,createdAt,result:response.result};}catch(error){error.transactionId=transactionId;error.createdAt=createdAt;throw error;}
  }
  async readPreferences(fragment,options) {
    await this.ensureSession(options);
    const generation=this.generation,session=this.session,result=(await this.rpc({resource:'@preferences',contract:session.preferencesContract,method:'read',args:{fragment}},options)).result;
    if(generation!==this.generation||this.session?.subject!==session.subject)throw new Error('Resource access was canceled.');
    for(const[field,value]of Object.entries(result.values??{}))for(const ref of Array.isArray(value)?value:[value])if(ref&&typeof ref==='object'&&typeof ref.id==='string'&&typeof ref.token==='string')this.references.set(ref,{fragment,field,id:ref.id,issuer:session.issuer,subject:session.subject,generation,accessToken:session.access_token,token:ref.token});
    for(const value of Object.values(result.values??{}))for(const ref of Array.isArray(value)?value:[value])if(ref&&typeof ref==='object'&&this.references.has(ref))deepFreeze(ref);
    return result;
  }
  signOut(){this.session=null;this.cancelLogin();}
}

async function boundedJSON(response){
  const type=response.headers.get('Content-Type')??'';if(!type.toLowerCase().includes('application/json'))throw new Error('Provider response must be JSON.');
  if(Number(response.headers.get('Content-Length'))>1500000)throw new Error('Provider response is too large.');
  let text;if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1500000){await reader.cancel();throw new Error('Provider response is too large.');}chunks.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}else text=await response.text();
  if(new TextEncoder().encode(text).length>1500000)throw new Error('Provider response is too large.');return JSON.parse(text);
}

function deepFreeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}
function validateAccessResponse(token,{issuer,clientId,rpcEndpoint,tokenEndpoint,preferencesContract,clock,requestStartedAt=clock(),previous}) {
  if(token.issuer!==issuer||token.client_id!==clientId||token.token_type!=='Bearer'||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>8192||!Number.isSafeInteger(token.expires_in)||token.expires_in<=0||token.expires_in>300||token.audience!==rpcEndpoint||typeof token.subject!=='string'||!Array.isArray(token.granted_fragments)||token.granted_fragments.length>8)throw new Error('Provider returned an invalid access token response.');
  const subject=new URL(token.subject);if(subject.origin!==issuer||!/^\/entities\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(subject.pathname)||subject.search||subject.hash||subject.username||subject.password)throw new Error('Provider returned an invalid identity subject.');
  if(token.refresh_token!==undefined&&(typeof token.refresh_token!=='string'||!token.refresh_token||token.refresh_token.length>8192||!Number.isSafeInteger(token.refresh_expires_in)||token.refresh_expires_in<=0||token.refresh_expires_in>28800||token.expires_in>token.refresh_expires_in))throw new Error('Provider returned an invalid session renewal credential.');
  for(const grant of token.granted_fragments)if(!grant||typeof grant.grant!=='string'||typeof grant.fragment!=='string'||typeof grant.digest!=='string'||!Array.isArray(grant.fields)||grant.fields.some(field=>typeof field!=='string')||new Set(grant.fields).size!==grant.fields.length)throw new Error('Provider returned invalid fragment grants.');
  if(previous){
    if(token.subject!==previous.subject||!token.refresh_token||token.refresh_token===previous.refresh_token)throw new Error('Provider changed the renewed session identity or reused its credential.');
    for(const grant of token.granted_fragments){const prior=previous.granted_fragments.find(item=>item.grant===grant.grant);if(!prior||prior.fragment!==grant.fragment||prior.digest!==grant.digest||grant.fields.some(field=>!prior.fields.includes(field)))throw new Error('Session renewal attempted to expand its approved grants.');}
    if(Array.isArray(token.grants)&&token.grants.some(grant=>!previous.grants?.includes(grant)))throw new Error('Session renewal attempted to expand its approved grants.');
  }
  const refreshExpiresAt=token.refresh_token?Math.min(requestStartedAt+token.refresh_expires_in*1000,previous?.refreshExpiresAt??Infinity):undefined;
  return deepFreeze({...token,rpcEndpoint,tokenEndpoint,preferencesContract,expiresAt:Math.min(requestStartedAt+token.expires_in*1000,refreshExpiresAt??Infinity),renewalCount:previous?(previous.renewalCount??0)+1:0,...refreshExpiresAt?{refreshExpiresAt}:{}});
}

function waitForRefresh(promise,signal){if(!signal)return promise;if(signal.aborted)return Promise.reject(new DOMException('The operation was canceled.','AbortError'));return new Promise((resolve,reject)=>{const aborted=()=>reject(new DOMException('The operation was canceled.','AbortError'));signal.addEventListener('abort',aborted,{once:true});promise.then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});});}

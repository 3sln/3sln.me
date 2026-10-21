// HTTP surface for the provider-owned authorization entry (issuer origin) and the 3sln embed API (embed origin).
// Mounted by packages/runtime/http.mjs ahead of handleFederation; returns null for unrelated requests. Root
// adapters keep IP/subnet admission, asset serving and page hardening (securePage) as for /oauth/authorize.
const privateHeaders={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
const json=(value,status=200,headers={},cookies=[])=>{const response=new Response(JSON.stringify(value),{status,headers:{...privateHeaders,'Content-Type':'application/json',...headers}});for(const cookie of cookies)response.headers.append('Set-Cookie',cookie);return response;};
const error=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const statuses={unauthorized:401,rate_limited:429,csrf:403,forbidden:403,not_found:404,temporarily_unavailable:503,account_already_chosen:409,account_mismatch:409,reauthentication_required:401,embed_attestation_required:403,embed_attestation_failed:403,consent_stale:409,stale_consent:409,account_context_conflict:409,session_context_conflict:409};
const ENTRY_PATH=/^\/api\/oauth\/entries\/([A-Za-z0-9_-]{43})(?:\/(select|decision|end-session|plain))?$/,EMBED_PATH=/^\/oauth\/entries\/([A-Za-z0-9_-]{43})\/(embed-challenge|embed-verify)$/;
async function body(request,max=32768){
 if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw error('json_required','Use JSON.',415);if(!request.body)return {};
 const reader=request.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw error('body_too_large','Request is too large.',413);chunks.push(value);}}catch(e){await reader.cancel();throw e;}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{const value=size?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):{};if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw error('invalid_request','Invalid JSON.');}
}
/** With metadata-document clients (client-id-metadata.v1) the creating app's origin cannot be known before the body
 * names its client, so any HTTPS origin may preflight; creation itself requires Origin to equal the client's origin. */
const metadataOrigin=origin=>{try{const u=new URL(origin);return u.protocol==='https:'&&u.origin===origin;}catch{return false;}};
/** Legacy single-cookie owner context; multi-account mounts pass their own resolver. */
export function legacyOwnerContext(request,{issuer,allowInsecureLocalhost=false}){const name=allowInsecureLocalhost?'bindle_session':'__Host-bindle_session';let sessionToken;for(const part of(request.headers.get('Cookie')??'').split(';')){const [k,...v]=part.trim().split('=');if(k===name){try{sessionToken=decodeURIComponent(v.join('='));}catch{throw error('unauthorized','Invalid session.',401);}}}return {sessionToken,csrfToken:request.headers.get('X-CSRF-Token'),origin:request.headers.get('Origin')??issuer};}
// Browsers omit Origin on same-origin GETs, so a GET without Origin must carry Sec-Fetch-Site: same-origin instead.
const sameOrigin=(request,issuer)=>{const site=request.headers.get('Sec-Fetch-Site'),origin=request.headers.get('Origin');if(origin===null?request.method!=='GET'||site!=='same-origin':origin!==issuer||site!==null&&site!=='same-origin')throw error('forbidden','Use the provider page.',403);};
/** Entry mutations come only from the provider page (hardening item 3): the exact Origin, browser-set Fetch Metadata
 * (`Sec-Fetch-Site: same-origin`) and the per-entry page token that only the same-origin view returns, sent as
 * X-Bindle-Entry-Token. The entry nonce is public and is never a CSRF token. */
export const ENTRY_TOKEN_HEADER='X-Bindle-Entry-Token';
function pageRequest(request,issuer){const token=request.headers.get(ENTRY_TOKEN_HEADER);if(request.headers.get('Origin')!==issuer||request.headers.get('Sec-Fetch-Site')!=='same-origin'||!token||!/^[A-Za-z0-9_-]{43}$/.test(token))throw error('csrf','Reload the provider page before continuing.',403);return {token};}
/** Issuer-origin routes. `entries` is an AuthorizationEntries instance (or the Worker facade). `endSession(request,
 * context,subject)` is the adapter's provider session-ending hook: it ends only this browser's session for `subject`
 * after verifying that member and its CSRF, and returns the Set-Cookie values to send. */
export async function handleAuthorizationEntry(request,{entries,issuer,assets,ownerContext,remote,endSession,enabled=true,allowInsecureLocalhost=false}){
 const url=new URL(request.url),path=url.pathname,entry=ENTRY_PATH.exec(path),embed=EMBED_PATH.exec(path);
 const document=path==='/oauth/authorize'&&url.searchParams.has('entry');
 if(path!=='/api/oauth/entries'&&!entry&&!embed&&!document)return null;let cors={};
 try{
  if(url.origin!==issuer)throw error('invalid_origin','Use the configured provider origin.',403);
  if(!enabled||!entries)throw error('temporarily_unavailable','Application sign-in is not available.',503);
  if(path==='/api/oauth/entries'){
   const origin=request.headers.get('Origin')??undefined,allowed=origin!==undefined&&([...entries.clients.values()].some(c=>c.origin===origin)||origin===entries.embedOrigin||entries.clientMetadata===true&&metadataOrigin(origin));
   if(origin!==undefined&&!allowed)throw error('forbidden','Application origin is not registered.',403);if(allowed)cors={'Access-Control-Allow-Origin':origin,Vary:'Origin'};
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...privateHeaders,...cors,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'}});
   if(request.method!=='POST')throw error('method_not_allowed','Use POST.',405);
   // Creation is cookieless and session-independent; failures never carry a reason.
   if(request.headers.get('Cookie'))throw error('invalid_request','The authorization entry could not be created.');
   let input;try{input=await body(request);}catch(e){if(e.status===413)throw e;throw error('invalid_request','The authorization entry could not be created.');}
   return json(await entries.create(input,{origin,remote:typeof remote==='function'?await remote(request):undefined}),201,cors);
  }
  if(document){
   if(request.method!=='GET')throw error('method_not_allowed','Use GET.',405);const keys=[...url.searchParams.keys()],mode=url.searchParams.get('mode')??undefined;
   if(keys.some(k=>!['entry','mode'].includes(k))||new Set(keys).size!==keys.length||!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('entry'))||mode!==undefined&&mode!=='plain')throw error('invalid_request','A provider-stored entry identifier is required.');
   if(!assets?.fetch)throw error('temporarily_unavailable','Authorization interface is unavailable.',503);
   // One static, cookie-independent document; no server redirect. Only an embed popup keeps its opener (§9).
   const policy=await entries.documentPolicy(url.searchParams.get('entry'),mode),page=await assets.fetch(new Request(new URL('/authorize.html',issuer),{method:'GET'})),headers=new Headers(page.headers);
   for(const [k,v]of Object.entries(privateHeaders))if(k!=='Content-Security-Policy')headers.set(k,v);headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");headers.set('Cross-Origin-Opener-Policy',policy);return new Response(page.body,{status:page.status,headers});
  }
  if(entry&&!entry[2]){if(request.method!=='GET')throw error('method_not_allowed','Use GET.',405);sameOrigin(request,issuer);return json(await entries.view(entry[1]));}
  if(request.method!=='POST')throw error('method_not_allowed','Use POST.',405);
  const page=pageRequest(request,issuer);
  if(embed){const input=await body(request,8192);if(embed[2]==='embed-verify')return json(await entries.verify(embed[1],input,page));if(Object.keys(input).length)throw error('invalid_request','No parameters.');return json(await entries.challenge(embed[1],page));}
  // Cookies are authenticated (member AEAD) before any entry branch; owner steps then authenticate the live session
  // and its CSRF before reading entry state, and cancel never uses the owner at all (S1).
  const context=typeof ownerContext==='function'?await ownerContext(request):legacyOwnerContext(request,{issuer,allowInsecureLocalhost}),input=await body(request,131072);
  if(entry[2]==='plain'){if(Object.keys(input).length)throw error('invalid_request','No parameters.');return json(await entries.declarePlain(entry[1],page));}
  if(entry[2]==='select')return json(await entries.select(entry[1],context,input,page));
  if(entry[2]==='decision')return json(await entries.decide(entry[1],context,input,page));
  // End-session: the confirmed subject's session in this browser ends before the entry completes.
  const {subject}=await entries.endTarget(entry[1],input,page);let cookies=[];
  if(input.confirmed){if(typeof endSession!=='function')throw error('temporarily_unavailable','Signing out is not available.',503);cookies=await endSession(request,context,subject)??[];}
  return json(await entries.finishSession(entry[1],input,page),200,{},cookies);
 }catch(e){const status=e.status??statuses[e.code]??400;return json({error:e.code??'invalid_request',message:e.code?e.message:'The sign-in request could not be completed.',...e.code==='rate_limited'&&e.ownerReviewUri?{owner_review_uri:e.ownerReviewUri}:{}},status,{...cors,...Number.isSafeInteger(e.retryAfter)&&e.retryAfter>0?{'Retry-After':String(e.retryAfter)}:{}});}
}
const EMBED_AUTH={session:'BindleEmbed',forget:'BindleEmbed',state:'BindleEmbedSession',avatar:'BindleEmbedSession',events:'BindleEmbedSession','session/end':'BindleEmbedSession'};
const EMBED_GET=['avatar','events'],EMBED_STREAM={tickMs:25000,maxMs:600000};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Fetch Metadata gate for `/embed/api/*` (adaptive §13.4, EIR-1). The browser-set `Sec-Fetch-Site: same-origin` is the
 * primary signal and is always required. `Origin` must then be the embed origin, absent on a GET (browsers omit it on
 * same-origin GETs) or the literal `null`. Fetch serializes a same-origin non-CORS request's origin as `null` when its
 * referrer policy is `no-referrer` (the shell's policy; observed in Firefox 157). `null` from an opaque origin (a sandboxed
 * or `data:` document) never arrives with `Sec-Fetch-Site: same-origin`, and `X-Bindle-Embed` cannot be sent
 * cross-origin because no CORS preflight is ever answered, so accepting it here admits no other initiator. */
export function embedRequestAllowed(request,embedOrigin){
 const origin=request.headers.get('Origin');
 return request.headers.get('Sec-Fetch-Site')==='same-origin'&&['cors','same-origin'].includes(request.headers.get('Sec-Fetch-Mode'))&&request.headers.get('Sec-Fetch-Dest')==='empty'&&request.headers.get('X-Bindle-Embed')==='1'
  &&(origin===embedOrigin||origin==='null'||origin===null&&['GET','HEAD'].includes(request.method));
}
/** Embed-origin API (§6.3, §7.4, §13.4): Fetch Metadata gated, no CORS, no cookies, constant failures. `avatars` reads and
 * re-encodes picture sources (packages/federation/embed-avatar.mjs); without it the avatar route always answers 404. */
export async function handleEmbedAPI(request,{authority,embedOrigin,enabled=true,avatars,stream=EMBED_STREAM,clock=()=>Date.now(),wait=sleep}){
 const url=new URL(request.url);if(!embedOrigin||url.origin!==embedOrigin||!url.pathname.startsWith('/embed/api/'))return null;
 const headers={'Cross-Origin-Resource-Policy':'same-origin'},deny=()=>json({error:'unauthorized'},401,headers);
 const route=/^\/embed\/api\/(nonce|claim|session|state|forget|session\/end|avatar|events)$/.exec(url.pathname)?.[1];
 if(!route||!embedRequestAllowed(request,embedOrigin))return json({error:'forbidden'},403,headers);
 // Proof-bound reads are GET; every other route mutates or consumes a single-use proof nonce, so it is POST.
 const method=EMBED_GET.includes(route)?'GET':'POST';
 if(request.method!==method)return json({error:'method_not_allowed'},405,{...headers,Allow:method});
 if(route==='avatar')return embedAvatar(request,url,{authority,enabled,avatars,clock,wait});
 try{
  if(!enabled||!authority)return json({error:'temporarily_unavailable'},503,headers);
  if(url.search&&route!=='avatar')return deny();
  if(route==='nonce')return json({nonce:await authority.dpopNonce('embed')},200,headers);
  const [scheme,value,...rest]=(request.headers.get('Authorization')??'').split(' '),bearer=EMBED_AUTH[route];
  if(route==='session/end'){if(scheme!==bearer||!value||rest.length)return deny();await authority.embedEnd({session:value});return new Response(null,{status:204,headers:{...privateHeaders,...headers}});}
  const dpop=request.headers.get('DPoP');if(!dpop||dpop.includes(',')||dpop.length>4096)return deny();
  if(route==='claim'){const input=await body(request,4096);if(Object.keys(input).length!==1||typeof input.claim!=='string')return deny();return json(await authority.redeemClaim({claim:input.claim,dpop}),200,headers);}
  if(scheme!==bearer||!value||rest.length)return deny();
  if(route==='session')return json(await authority.embedSession({credential:value,dpop}),200,headers);
  if(route==='state')return json(await authority.embedState({session:value,dpop}),200,headers);
  if(route==='events')return eventStream(await authority.embedEvents({session:value,dpop}),{authority,session:value,stream,signal:request.signal,headers});
  return json(await authority.embedForget({credential:value,dpop}),200,headers);
 }catch(e){if(e.code==='rate_limited')return json({error:'rate_limited'},429,headers);if(e.code==='temporarily_unavailable')return json({error:'temporarily_unavailable'},503,headers);return deny();}
}
/** `GET /embed/api/avatar?s=<bucket>` (embed islands §6.2): session bearer plus a GET key proof; a freshly re-encoded
 * PNG; CORP same-origin, no CORS, no-store, a sandboxing CSP. Every outcome (bytes, no picture, refused proof, unreadable
 * source) is released at the same fixed deadline after arrival, so timing does not separate them. Work still running at
 * the deadline is abandoned and answered as `not_found`, so the deadline is a ceiling as well as a floor. */
async function embedAvatar(request,url,{authority,enabled,avatars,clock,wait}){
 const started=clock(),deadline=started+(avatars?.responseMs??1500),base={...privateHeaders,'Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"sandbox; default-src 'none'"};
 const settle=async response=>{const left=deadline-clock();if(left>0)await wait(left);return response;};
 const failure=(status,error)=>new Response(JSON.stringify({error}),{status,headers:{...base,'Content-Type':'application/json'}});
 let outcome=failure(401,'unauthorized');
 const work=(async()=>{try{
  const keys=[...url.searchParams.keys()],size=Number(url.searchParams.get('s'));
  const [scheme,value,...rest]=(request.headers.get('Authorization')??'').split(' '),dpop=request.headers.get('DPoP');
  if(!enabled||!authority)outcome=failure(503,'temporarily_unavailable');
  else if(keys.length!==1||keys[0]!=='s'||!/^(?:64|128|256|512)$/.test(url.searchParams.get('s'))||scheme!=='BindleEmbedSession'||!value||rest.length||!dpop||dpop.includes(',')||dpop.length>4096)outcome=failure(401,'unauthorized');
  else{
   let source=null;try{source=(await authority.embedAvatar({session:value,dpop})).avatar;}catch(e){outcome=e.code==='rate_limited'?failure(429,'rate_limited'):failure(401,'unauthorized');throw e;}
   outcome=failure(404,'not_found');
   if(source&&avatars){const bytes=await avatars.render(source,size);outcome=new Response(bytes,{status:200,headers:{...base,'Content-Type':'image/png','Content-Length':String(bytes.byteLength)}});}
  }
 }catch{}return outcome;})();
 // The ceiling uses a real timer (cleared when the work settles); `wait` pads a finished outcome to the deadline.
 let timer;const late=Symbol('late'),result=await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(late),Math.max(0,deadline-clock()));})]);clearTimeout(timer);
 return result===late?failure(404,'not_found'):settle(result);
}
/** `GET /embed/api/events`: the leader's single data stream (embed islands §5.1). NDJSON: the current view first, then a
 * heartbeat that re-checks the lease, the session and the binding, sending the view again only when it changed. The stream
 * ends at session expiry, on eviction by a newer stream for the same credential, or when the binding stops being live. */
function eventStream(opened,{authority,session,stream,signal,headers}){
 const encoder=new TextEncoder(),line=value=>encoder.encode(JSON.stringify(value)+'\n'),until=Date.now()+Math.min(stream.maxMs,Math.max(0,Number(opened.expires_in)||0)*1000);
 let timer=null,last=JSON.stringify(opened.view),closed=false;
 const body=new ReadableStream({
  start(controller){
   const close=()=>{if(closed)return;closed=true;clearTimeout(timer);try{controller.close();}catch{}};
   signal?.addEventListener('abort',close,{once:true});
   controller.enqueue(line({type:'view',view:opened.view}));
   const tick=async()=>{
    if(closed)return;if(Date.now()>=until)return close();
    try{const {view}=await authority.embedEventsTick({session,lease:opened.lease}),next=JSON.stringify(view);if(closed)return;controller.enqueue(line(next===last?{type:'ping'}:{type:'view',view}));last=next;}catch{return close();}
    timer=setTimeout(tick,stream.tickMs);
   };
   timer=setTimeout(tick,stream.tickMs);
  },
  cancel(){closed=true;clearTimeout(timer);},
 });
 return new Response(body,{status:200,headers:{...privateHeaders,...headers,'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'}});
}

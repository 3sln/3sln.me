import {BROKERING_JWKS_PATH,JWKS_MAX_AGE,brokeringManifest} from './signing.mjs';
const privateHeaders={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{...privateHeaders,'Content-Type':'application/json',...headers}});
const error=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const routes=path=>path==='/.well-known/bindle/manifest.json'||path==='/oauth/authorize'||path==='/oauth/token'||path==='/oauth/revoke'||path==='/oauth/jwks'||path==='/bindle/rpc'||path==='/api/oauth/requests'||/^\/api\/oauth\/requests\/(?:[a-f0-9-]{36}\.)?[A-Za-z0-9_-]{43}(?:\/decision)?$/.test(path)||path==='/api/preferences'||path==='/api/grants'||/^\/api\/grants\/(?:[a-f0-9-]{36}\.)?[A-Za-z0-9_-]{43}$/.test(path);
async function readBody(request,max=131072){if(!request.body)throw error('invalid_request','Request body required.');const reader=request.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw error('body_too_large','Request is too large.',413);chunks.push(value);}}catch(e){await reader.cancel();throw e;}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw error('invalid_request','Invalid UTF-8 body.');}}
async function jsonBody(request){if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw error('json_required','Use JSON.',415);try{const value=JSON.parse(await readBody(request,new URL(request.url).pathname==='/bindle/rpc'?1500000:131072));if(!value||typeof value!=='object'||Array.isArray(value))throw error('invalid_request','JSON object required.');return value;}catch(e){if(e.code)throw e;throw error('invalid_request','Invalid JSON.');}}
function sessionContext(request,local,issuer){const name=local?'bindle_session':'__Host-bindle_session';let sessionToken;for(const part of(request.headers.get('Cookie')??'').split(';')){const [key,...value]=part.trim().split('=');if(key===name){try{sessionToken=decodeURIComponent(value.join('='));}catch{throw error('unauthorized','Invalid session.',401);}}}return {sessionToken,csrfToken:request.headers.get('X-CSRF-Token'),origin:request.headers.get('Origin')??issuer};}
/** A fresh token-endpoint DPoP nonce (RFC 9449 §8), when DPoP is configured. */
async function tokenNonce(controller){try{return typeof controller?.dpopNonce==='function'?{'DPoP-Nonce':await controller.dpopNonce('token'),'Access-Control-Expose-Headers':'DPoP-Nonce'}:{};}catch{return {};}}
function formParams(text,allowed){const params=new URLSearchParams(text);if(new Set(params.keys()).size!==[...params.keys()].length||[...params.keys()].some(key=>!allowed.includes(key)))throw error('invalid_request','Invalid form parameters.');return params;}
function ownerMutation(request,issuer){if(request.headers.get('Origin')!==issuer||!request.headers.get('X-CSRF-Token'))throw error('csrf','Reload the provider page before continuing.',403);}
/** CORS for a named client: its registered origin, or for a metadata-document client the origin of its URL ID (its
 * redirect URIs must share it), unless an administrator blocked that host. No metadata is fetched here. */
async function clientOrigin(request,clients,clientId,issuer,directory){const origin=request.headers.get('Origin');if(!origin||origin===issuer)return {};const client=clients.find(c=>c.id===clientId);let expected=client?.origin;
 if(!client&&directory?.isMetadataId(clientId)){try{await directory.assertAllowed(clientId);expected=directory.originOf(clientId);}catch{expected=undefined;}}
 if(!expected||expected!==origin)throw error('forbidden','Application origin is not registered.',403);return {'Access-Control-Allow-Origin':origin,Vary:'Origin'};}
/** A preflight cannot name its client. With metadata clients enabled, the public client endpoints answer preflights from
 * any HTTPS origin; the actual request is then checked against the named client (or the token's client). */
const preflightOrigin=(origin,path,directory)=>{if(!directory?.enabled||!['/api/oauth/requests','/oauth/token','/oauth/revoke','/bindle/rpc'].includes(path))return false;try{const u=new URL(origin);return u.protocol==='https:'&&u.origin===origin;}catch{return false;}};
/** Returns null for unrelated routes. Root HTTP adapters remain responsible for
 * caller IP/rate limits and asset serving; no platform SDK appears here. `ownerContext(request)`
 * lets an adapter resolve its own session cookies (multi-account members); default: the legacy cookie. */
/** `brokering` ({enabled, jwks()}) exists only when BROKERING_ENABLED is true; otherwise its JWKS route does not exist.
 * Once the EXT-X8 registry row declares `brokered-resources.v1`, its `jwks_uri` replaces the provisional top-level
 * `brokering_jwks_uri` (X8-R6: X6/X7 verifiers keep finding the key set until then). */
async function brokeringJwks(request,brokering){const body=JSON.stringify(await brokering.jwks()),etag=`"${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')}"`;
 const headers={...privateHeaders,'Cache-Control':`public, max-age=${JWKS_MAX_AGE}, must-revalidate`,'Content-Type':'application/jwk-set+json','Access-Control-Allow-Origin':'*',ETag:etag};
 return request.headers.get('If-None-Match')===etag?new Response(null,{status:304,headers}):new Response(body,{status:200,headers});}
export async function handleFederation(request,{controller,issuer,clients=controller?.clients??[],directory=controller?.directory,allowInsecureLocalhost=false,assets,enabled=true,ownerContext,brokering}){
 const url=new URL(request.url),brokered=brokering?.enabled===true&&typeof brokering.jwks==='function';if(!routes(url.pathname)&&!(brokered&&url.pathname===BROKERING_JWKS_PATH))return null;let cors={};
 try{
  if(url.origin!==issuer)throw error('invalid_origin','Use the configured provider origin.',403);
  if(!enabled||!controller||!await controller.ready())throw error('temporarily_unavailable','Federation is not configured and release enabled.',503);
  const path=url.pathname,origin=request.headers.get('Origin'),context=typeof ownerContext==='function'?await ownerContext(request):sessionContext(request,allowInsecureLocalhost,issuer);
  if(request.method==='OPTIONS'){if(origin!==issuer&&!clients.some(c=>c.origin===origin)&&!preflightOrigin(origin,path,directory))throw error('forbidden','Application origin is not registered.',403);return new Response(null,{status:204,headers:{...privateHeaders,'Access-Control-Allow-Origin':origin,Vary:'Origin','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization, DPoP','Access-Control-Max-Age':'600'}});}
  if(path==='/.well-known/bindle/manifest.json'&&request.method==='GET'){const manifest=await controller.manifest();return json({...manifest,...brokered&&!manifest.features?.['brokered-resources.v1']?brokeringManifest(issuer):{}},200,{'Access-Control-Allow-Origin':'*'});}
  if(brokered&&path===BROKERING_JWKS_PATH&&request.method==='GET')return await brokeringJwks(request,brokering);
  if(path==='/oauth/jwks'&&request.method==='GET')return json({keys:[]},200,{'Access-Control-Allow-Origin':'*'});
  if(path==='/oauth/authorize'&&request.method==='GET'){const id=url.searchParams.get('request_id');if(!id||!/^(?:[a-f0-9-]{36}\.)?[A-Za-z0-9_-]{43}$/.test(id)||[...url.searchParams.keys()].some(k=>k!=='request_id'))throw error('invalid_request','A provider-stored request identifier is required.');await controller.inspect(undefined,id);if(!assets?.fetch)throw error('temporarily_unavailable','Authorization interface is unavailable.',503);const page=await assets.fetch(new Request(new URL('/authorize.html',issuer),{method:'GET'}));const headers=new Headers(page.headers);for(const[k,v]of Object.entries(privateHeaders))headers.set(k,v);return new Response(page.body,{status:page.status,headers});}
  if(path==='/api/oauth/requests'&&request.method==='POST'){const input=await jsonBody(request);cors=await clientOrigin(request,clients,input.clientId,issuer,directory);return json(await controller.beginAuthorization(input),201,cors);}
  const match=/^\/api\/oauth\/requests\/((?:[a-f0-9-]{36}\.)?[A-Za-z0-9_-]{43})(\/decision)?$/.exec(path);
  if(match&&!match[2]&&request.method==='GET')return json(await controller.inspect(context,match[1]));
  if(match&&match[2]&&request.method==='POST'){ownerMutation(request,issuer);const input=await jsonBody(request);if(input.requestId!==match[1])throw error('invalid_request','Request identifier does not match the path.');return json(await controller.approve(context,input));}
  if(path==='/api/preferences'&&request.method==='GET')return json(await controller.preferences(context));
  if(path==='/api/preferences'&&request.method==='POST'){ownerMutation(request,issuer);return json(await controller.configure(context,await jsonBody(request)));}
  if(path==='/api/grants'&&request.method==='GET')return json(await controller.grants(context));
  const revoke=/^\/api\/grants\/((?:[a-f0-9-]{36}\.)?[A-Za-z0-9_-]{43})$/.exec(path);if(revoke&&request.method==='DELETE'){ownerMutation(request,issuer);return json(await controller.revoke(context,revoke[1]));}
  if(path==='/oauth/token'&&request.method==='POST'){
    let input,refresh=false;
    if(request.headers.get('Content-Type')?.split(';')[0].trim()==='application/x-www-form-urlencoded'){
      const params=new URLSearchParams(await readBody(request,8192));if(new Set(params.keys()).size!==[...params.keys()].length)throw error('invalid_request','Repeated token parameters are not allowed.');
      const grant=params.get('grant_type');refresh=grant==='refresh_token';
      const allowed=[...(refresh?['grant_type','refresh_token','client_id']:['grant_type','code','code_verifier','client_id','redirect_uri']),...directory?.integrations?['client_assertion','client_assertion_type']:[]];
      if(!['authorization_code','refresh_token'].includes(grant)||[...params.keys()].some(key=>!allowed.includes(key)))throw error('invalid_request','Invalid token exchange.');
      input=refresh?{refreshToken:params.get('refresh_token'),clientId:params.get('client_id')}:{code:params.get('code'),verifier:params.get('code_verifier'),clientId:params.get('client_id'),redirectUri:params.get('redirect_uri')};
      if(params.has('client_assertion'))input.clientAssertion=params.get('client_assertion');if(params.has('client_assertion_type'))input.clientAssertionType=params.get('client_assertion_type');
    }else {input=await jsonBody(request);if(Object.hasOwn(input,'clientAssertion')||Object.hasOwn(input,'clientAssertionType'))throw error('invalid_request','Client assertions require form encoding.');if(Object.hasOwn(input,'dpop'))throw error('invalid_request','Send DPoP proofs in the DPoP header.');if(input.grantType==='refresh_token'){refresh=true;const {grantType,...fields}=input;input=fields;}}
    // RFC 9449: exactly one proof header; a repeated header joins with a comma and is rejected.
    const proof=request.headers.get('DPoP');if(proof!==null){if(proof.includes(',')||proof.length>4096)throw error('invalid_dpop_proof','Send exactly one DPoP proof.');input.dpop=proof;}
    cors=await clientOrigin(request,clients,input.clientId,issuer,directory);const result=await(refresh?controller.refresh(input):controller.exchange(input));return json(result,200,{...cors,...await tokenNonce(controller)});
  }
  if(path==='/oauth/revoke'&&request.method==='POST'){
    if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/x-www-form-urlencoded')throw error('invalid_request','Use a form-encoded revocation request.');
    const params=formParams(await readBody(request,8192),['token','token_type_hint','client_id']);if(!params.get('token')||!params.get('client_id'))throw error('invalid_request','Token and client are required.');
    cors=await clientOrigin(request,clients,params.get('client_id'),issuer,directory);await controller.revokeToken({token:params.get('token'),clientId:params.get('client_id'),...params.has('token_type_hint')?{tokenTypeHint:params.get('token_type_hint')}:{}});return json({},200,cors);
  }
  if(path==='/bindle/rpc'&&request.method==='POST'){if(origin&&origin!==issuer&&!clients.some(c=>c.origin===origin)&&!(directory?.enabled&&controller.tokenClient))throw error('forbidden','Application origin is not registered.',403);if(origin&&origin!==issuer)cors={'Access-Control-Allow-Origin':origin,Vary:'Origin'};const bearer=request.headers.get('Authorization');if(!bearer?.startsWith('Bearer '))throw error('unauthorized','Bearer token required.',401);const token=bearer.slice(7);if(controller.tokenClient&&origin&&origin!==issuer){const clientId=await controller.tokenClient(token);await clientOrigin(request,clients,clientId,issuer,directory);}const envelope=await jsonBody(request);return json(await controller.rpc(token,envelope,{requestOrigin:origin}),200,cors);}
  return json({error:'method_not_allowed',message:'This endpoint does not support that method.'},405,cors);
 }catch(e){const status=e.status??({unauthorized:401,invalid_token:401,rate_limited:429,consent_stale:409,stale_consent:409,csrf:403,forbidden:403,invalid_client:400,invalid_grant:400,not_found:404,tx_conflict:409,temporarily_unavailable:503}[e.code]??400);return json({error:e.code??'invalid_request',message:e.code?e.message:'The federation request could not be completed.'},status,{...cors,...url.pathname==='/oauth/token'?await tokenNonce(controller):{},...Number.isSafeInteger(e.retryAfter)&&e.retryAfter>0?{'Retry-After':String(e.retryAfter)}:{}});}
}

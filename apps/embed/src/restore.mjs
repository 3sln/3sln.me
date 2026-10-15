// Embed API client, entry creation and leader-only restore (adaptive-app-sign-in §6.3, §7.1, §7.4; slice A5).
// Runs only in the island worker. Contracts: packages/runtime/federation-entry-http.mjs `handleEmbedAPI`
// (`X-Bindle-Embed: 1`; POST except the proof-bound GET reads; DPoP with a fresh server nonce and `ath` over the bound value)
// and packages/federation/authorization-entries.mjs `create` (cookieless, CORS for the embed origin only).
// Failures are never reported outward: callers get null and keep the neutral state. Same-origin embed API calls
// use referrerPolicy 'same-origin', so a same-origin POST carries the exact Origin. Under 'no-referrer' Fetch serializes
// it as `null` (observed in Firefox 157); the server accepts `null` only with `Sec-Fetch-Site: same-origin`.
export const RESTORE_PAD_MS=300;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class EmbedAPIError extends Error{constructor(status){super('embed api');this.status=status;}}

export function embedAPI({origin,key,fetch=globalThis.fetch.bind(globalThis)}){
  const url=route=>`${origin}/embed/api/${route}`;
  const post=async(route,{auth,body,proofOver}={})=>{
    const headers={'X-Bindle-Embed':'1'};
    if(proofOver!==undefined){const {nonce}=await post('nonce');headers.DPoP=await key.dpop({htu:url(route),nonce,ath:proofOver});}
    if(auth)headers.Authorization=auth;if(body)headers['Content-Type']='application/json';
    const response=await fetch(url(route),{method:'POST',headers,body:body?JSON.stringify(body):undefined,mode:'same-origin',credentials:'omit',cache:'no-store',referrerPolicy:'same-origin'});
    if(!response.ok)throw new EmbedAPIError(response.status);
    const value=await response.json();if(!value||typeof value!=='object'||Array.isArray(value))throw new EmbedAPIError(502);return value;
  };
  return Object.freeze({
    nonce:()=>post('nonce'),
    claim:claim=>post('claim',{body:{claim},proofOver:claim}),
    session:credential=>post('session',{auth:`BindleEmbed ${credential}`,proofOver:credential}),
    state:session=>post('state',{auth:`BindleEmbedSession ${session}`,proofOver:session}),
    forget:credential=>post('forget',{auth:`BindleEmbed ${credential}`,proofOver:credential}),
    /** Avatar bytes (embed-islands §6.2): session bearer plus a GET key proof (`htu` without the query), fetch-only,
     * never cached. Server: packages/runtime/federation-entry-http.mjs `embedAvatar`. */
    async avatar(session,bucket){const {nonce}=await post('nonce'),htu=url('avatar');
      const response=await fetch(`${htu}?s=${bucket}`,{headers:{Authorization:`BindleEmbedSession ${session}`,'X-Bindle-Embed':'1',DPoP:await key.dpop({htm:'GET',htu,nonce,ath:session})},mode:'same-origin',credentials:'omit',cache:'no-store',referrerPolicy:'same-origin'});if(!response.ok)throw new EmbedAPIError(response.status);return response.blob();},
  });
}

/** Creates the authorization entry from the element's public inputs, the clicked intent and the frame key (§7.1). */
export async function createEntry({issuer,clientId,key,prepare,intent='login',fetch=globalThis.fetch.bind(globalThis)}){
  const body={clientId,redirectUri:prepare.redirectUri,challenge:prepare.challenge,challengeMethod:'S256',state:prepare.state,intent,requests:prepare.requests,presentation:'popup',delivery:'embed-popup',embedJkt:key.jkt,
    ...prepare.loginHint?{loginHint:prepare.loginHint}:{},...prepare.uiLocales?.length?{uiLocales:prepare.uiLocales}:{},...prepare.colorScheme?{colorScheme:prepare.colorScheme}:{},...prepare.dpopJkt?{dpopJkt:prepare.dpopJkt}:{}};
  const response=await fetch(`${issuer}/api/oauth/entries`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),mode:'cors',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
  if(!response.ok)throw new EmbedAPIError(response.status);const {entryId}=await response.json();
  if(typeof entryId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(entryId))throw new EmbedAPIError(502);return entryId;
}

/** Views are normalized and bounded before they reach any document. */
export function normalizeView(view,{issuer}){
  if(!view||typeof view!=='object')return null;const handle=typeof view.handle==='string'?view.handle.slice(0,320):null;if(!handle)return null;
  let subject=null;if(typeof view.subject==='string'&&view.subject.length<=2048){try{if(new URL(view.subject).origin===issuer)subject=view.subject;}catch{}}
  return Object.freeze({handle,name:typeof view.name==='string'&&view.name?view.name.slice(0,200):null,subject,avatar:Boolean(view.avatar)});
}

/** Leader-only restore: serial, each padded to ≥300 ms, independent of the app's current subject (§6.3). */
/** `slots` pads the batch to a fixed count so its duration does not reveal how many bindings exist (IMPL-7). */
export async function restoreAll(api,credentials,{issuer,pad=RESTORE_PAD_MS,slots=0,clock=()=>Date.now(),wait=sleep,signal}={}){
  const results=[];
  for(const record of credentials){
    if(signal?.aborted)break;const started=clock();let result={id:record.id,ok:false,status:0};
    try{const value=await api.session(record.credential);if(typeof value.session==='string'&&value.session)result={id:record.id,ok:true,session:value.session,expiresAt:clock()+Math.max(60,Math.min(Number(value.expires_in)||600,3600))*1000,view:normalizeView(value.view,{issuer})};}
    catch(error){result.status=error?.status??0;}
    results.push(result);const left=pad-(clock()-started);if(left>0)await wait(left);
  }
  if(slots>results.length&&pad>0&&!signal?.aborted)await wait(pad*(slots-results.length));
  return results;
}

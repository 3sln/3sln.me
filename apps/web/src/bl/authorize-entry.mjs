// Provider-owned authorization entry page, `authorization_endpoint?entry=<id>` (embeddable-elements S4/D1,
// adaptive-app-sign-in §5, §7.3–7.4, §9, §13.2, multi-account-ui "App-requested account flows"; slice A7).
// One static document drives every intent from same-origin fetches: it never navigates until a decision exists.
// Nothing reaches the application before the user decides: no messages, no redirect, no account-dependent
// timing beyond what §8.2 accepts. The account list, chooser, consent and end-session confirmation are provider
// UI only. Server routes: packages/runtime/federation-entry-http.mjs over packages/federation/authorization-entries.mjs.
import {Action,Query} from '../shared/stack.mjs';
import {runHandshake,deliverToOpener,embedOriginFor} from './authorize-entry-embed.mjs';
export const INTENTS=Object.freeze(['login','select-account','reauthenticate','end-session']);
const ID=/^[A-Za-z0-9_-]{43}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,REQUEST=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
const CODE=/^[\x21-\x7e]{1,2048}$/,CLAIM=/^[A-Za-z0-9._~-]{32,256}$/;
const exactKeys=(value,allowed)=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
/** Callback schemes: HTTPS, or plain HTTP only on loopback (javascript:/data: URLs have the opaque origin 'null'). */
const webScheme=url=>url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);

/** `/oauth/authorize?entry=<43>[&mode=plain]` and nothing else (the server enforces the same grammar). */
export function parseEntryLocation({pathname,search}){
 if(pathname!=='/oauth/authorize')return null;const query=new URLSearchParams(search),keys=[...query.keys()];
 if(keys.some(k=>!['entry','mode'].includes(k))||new Set(keys).size!==keys.length)return null;
 const entryId=query.get('entry'),mode=query.get('mode');if(!ID.test(entryId??'')||mode!==null&&mode!=='plain')return null;
 return {entryId,plain:mode==='plain'};
}
export const plainURL=entryId=>`/oauth/authorize?entry=${encodeURIComponent(entryId)}&mode=plain`;
export const subjectOf=(issuer,owner)=>`${issuer}/entities/${owner}`;
/** Session-independent request metadata from GET /api/oauth/entries/<id>, checked before it drives any UI. */
export function validEntryView(value,issuer){
 const e=value?.entry;
 if(!exactKeys(value,['entry'])||!exactKeys(e,['client','redirectUri','intent','requests','presentation','delivery','nonce','expiresAt','loginHint','subjectConstraint','maxAge','uiLocales','colorScheme','embed']))fail('invalid_entry','This sign-in request is not valid.');
 let redirect;try{redirect=new URL(e.redirectUri);}catch{fail('invalid_entry','This sign-in request is not valid.');}
 const client=e.client;
 if(!client||typeof client.id!=='string'||typeof client.origin!=='string'||client.origin!==redirect.origin||client.name!==undefined&&typeof client.name!=='string'||!INTENTS.includes(e.intent)||!Array.isArray(e.requests)||e.requests.length>8||!['redirect','popup'].includes(e.presentation)||!['redirect','popup','embed-popup'].includes(e.delivery)||typeof e.nonce!=='string'||!/^[A-Za-z0-9_-]{16,64}$/.test(e.nonce)||!Number.isSafeInteger(e.expiresAt)||!webScheme(redirect)||redirect.username||redirect.password||redirect.hash)fail('invalid_entry','This sign-in request is not valid.');
 const constrained=['reauthenticate','end-session'].includes(e.intent),owner=typeof e.subjectConstraint==='string'&&e.subjectConstraint.startsWith(`${issuer}/entities/`)?e.subjectConstraint.slice(issuer.length+10):null;
 if(constrained!==(e.subjectConstraint!==undefined)||constrained&&!UUID.test(owner??'')||(e.intent==='reauthenticate')!==(e.maxAge!==undefined)||e.maxAge!==undefined&&(!Number.isSafeInteger(e.maxAge)||e.maxAge<0||e.maxAge>86400)||e.loginHint!==undefined&&(typeof e.loginHint!=='string'||e.loginHint.length>320))fail('invalid_entry','This sign-in request is not valid.');
 if(e.delivery==='embed-popup'&&!exactKeys(e.embed,['attested','plain','origin']))fail('invalid_entry','This sign-in request is not valid.');
 return Object.freeze({client:Object.freeze({id:client.id,name:client.name||client.origin,origin:client.origin}),redirectUri:e.redirectUri,intent:e.intent,requests:structuredClone(e.requests),presentation:e.presentation,delivery:e.delivery,nonce:e.nonce,expiresAt:e.expiresAt,...e.loginHint?{loginHint:e.loginHint}:{},...constrained?{subjectConstraint:e.subjectConstraint,subjectOwner:owner}:{},...e.maxAge!==undefined?{maxAge:e.maxAge}:{},...e.delivery==='embed-popup'?{embed:Object.freeze({attested:e.embed.attested===true,plain:e.embed.plain===true,...typeof e.embed.origin==='string'?{origin:e.embed.origin}:{}})}:{}});
}
/** A provider-produced callback must be exactly the entry's registered redirect URI plus the allowed result keys. */
export function callbackTarget(href,redirectUri,issuer,allowed){
 const refuse=()=>fail('callback_mismatch','The callback origin does not match this application.');
 let target,expected;try{target=new URL(href);expected=new URL(redirectUri);}catch{refuse();}
 if(!webScheme(expected)||!webScheme(target)||target.username||target.password||target.hash||target.origin!==expected.origin||target.pathname!==expected.pathname)refuse();
 for(const [key,value] of expected.searchParams)if(target.searchParams.getAll(key).length!==1||target.searchParams.get(key)!==value)refuse();
 for(const key of new Set(target.searchParams.keys()))if(!expected.searchParams.has(key)&&(!allowed.includes(key)||target.searchParams.getAll(key).length!==1))refuse();
 if(target.searchParams.has('iss')&&target.searchParams.get('iss')!==issuer)refuse();
 return target;
}
/** First-party inventory from GET /api/auth/accounts (handles and non-secret selectors only). */
export function parseAccounts(result){
 if(!Array.isArray(result?.accounts)||result.accounts.length>20)fail('invalid_accounts','The account list could not be loaded.');const seen=new Set();
 return result.accounts.map(entry=>{const a=entry?.account;if(!a||!UUID.test(a.id)||seen.has(a.id)||typeof a.handle!=='string'||!a.handle||a.handle.length>128||typeof entry.sessionContext!=='string'||!entry.sessionContext||entry.sessionContext.length>128)fail('invalid_accounts','The account list could not be loaded.');seen.add(a.id);return Object.freeze({id:a.id,handle:a.handle,sessionContext:entry.sessionContext});});
}
/** Accounts this entry may use: the constrained subject only, the app's login hint first (a hint is never a choice). */
export function eligibleAccounts(accounts,entry,issuer){
 const hint=entry.loginHint?.split('@')[0]?.toLowerCase();
 const allowed=accounts.filter(account=>!entry.subjectConstraint||subjectOf(issuer,account.id)===entry.subjectConstraint).map(account=>({...account,hinted:Boolean(hint)&&account.handle.toLowerCase()===hint}));
 return allowed.sort((a,b)=>Number(b.hinted)-Number(a.hinted));
}
/** A bounded human duration for maxAge (seconds), as {count, unit} for the catalogue. */
export function durationOf(seconds){if(seconds<120)return {count:Math.max(seconds,0),unit:'seconds'};if(seconds<7200)return {count:Math.round(seconds/60),unit:'minutes'};return {count:Math.round(seconds/3600),unit:'hours'};}
// Fixed provider copy for server failures; server text is never echoed into the page.
const failures={rate_limited:'Too many sign-in attempts. Try again shortly.',account_already_chosen:'This sign-in already chose another account. Start again from the application.',account_mismatch:'Sign in to the account this application asked about.',embed_attestation_required:'This window can no longer continue. Start again from the application.',embed_attestation_failed:'This window can no longer continue. Start again from the application.',csrf:'Reload this page before continuing.',consent_stale:'Your shared preferences changed. Review them again.',stale_consent:'Your shared preferences changed. Review them again.',temporarily_unavailable:'Application sign-in is not available right now. Try again later.',invalid_request:'This sign-in expired or is no longer valid. Start again from the application.',invalid_entry:'This sign-in request is not valid.',callback_mismatch:'The callback origin does not match this application.',unauthorized:'That account is no longer signed in. Choose an account again.',account_context_conflict:'That account is no longer signed in. Choose an account again.',session_context_conflict:'That account is no longer signed in. Choose an account again.',invalid_accounts:'The account list could not be loaded.',vault_conflict:'The account list changed. Review it and try again.'};
export const failureMessage=(error,t)=>t(failures[error?.code]??'The request could not be completed.');

/** Same-origin JSON client. Private requests name their member (`X-Bindle-Account`/`-Session-Context`). */
export function createEntryAPI({fetch=(...args)=>globalThis.fetch(...args)}={}){
 async function call(path,{method='GET',body,member,csrf,anonymous=false}={}){
  const headers={Accept:'application/json'};
  if(member&&!member.legacy){headers['X-Bindle-Account']=member.id;headers['X-Bindle-Session-Context']=member.sessionContext;}
  if(body!==undefined){headers['Content-Type']='application/json';if(csrf)headers['X-CSRF-Token']=csrf;}
  const response=await fetch(path,{method,credentials:anonymous?'omit':'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers,...body!==undefined?{body:JSON.stringify(body)}:{}});
  let value=null;try{value=await response.json();}catch{}
  if(!response.ok)throw Object.assign(new Error('The request could not be completed.'),{code:typeof value?.error==='string'?value.error:'request_failed',status:response.status});
  if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('The request could not be completed.'),{code:'request_failed',status:response.status});
  return value;
 }
 return Object.freeze({get:(path,options)=>call(path,options),post:(path,body,options={})=>call(path,{...options,method:'POST',body})});
}
// Phases: loading → (framed|sandboxed|invalid|expired|unavailable) | handshake → choose|end-session → reauth|consent → returning → closed.
export const TERMINAL=Object.freeze(['framed','sandboxed','invalid','expired','unavailable','returning','closed']);
export function createEntryModel(){return {phase:'loading',entryId:null,mode:null,entry:null,accounts:null,accountsLoading:false,selected:null,reauth:null,consent:null,busy:false,error:'',notice:'',outcome:null,surface:0,selection:new Map(),drafts:new Map(),dirty:new Set()};}
/** Per-page secrets stay outside the rendered model: the attested page secret and the chosen member's CSRF. */
export const createEntrySecrets=()=>({pageSecret:null,embedOrigin:null,member:null});
const changed=ctx=>ctx.engineFeed.dispatchEvent(new Event('entry-changed'));
export class EntryView extends Query {static deps=['model'];boot({model},{notify,engineFeed}){this.feed=engineFeed;this.publish=()=>notify({...model});engineFeed.addEventListener('entry-changed',this.publish);this.publish();}kill(){this.feed.removeEventListener('entry-changed',this.publish);}}
const phase=(model,next)=>{if(model.phase!==next){model.phase=next;model.surface++;}};

export class EntryAction extends Action {
 static deps={model:{write:true},secrets:{write:true},api:{},browser:{},i18n:{},consent:{}};
 constructor(kind,detail={}){super();this.kind=kind;this.detail=detail;}
 async execute(deps,ctx){
  const {model}=deps;
  if(this.kind==='accounts'){if(model.busy||model.accountsLoading||!['choose','reauth','end-session'].includes(model.phase))return;const before=model.accounts?.map(a=>a.id+a.sessionContext).join()??'';
   // An explicit "Check again" always reports its result; automatic focus refreshes stay quiet.
   try{await this.loadAccounts(deps,ctx);if(this.detail.explicit)model.notice=deps.i18n.t((model.accounts?.map(a=>a.id+a.sessionContext).join()??'')===before?'No new sign-in found on this browser yet.':'Updated the accounts signed in on this browser.');}catch(error){if(this.detail.explicit)model.error=failureMessage(error,deps.i18n.t);}changed(ctx);return;}
  if(this.kind==='expire'){if(TERMINAL.includes(model.phase)||model.busy)return;phase(model,'expired');model.error='';changed(ctx);return;}
  // The sign-in link opens the console itself (target=_blank, noopener); this only explains what happens next.
  if(this.kind==='open-signin'){model.notice=deps.i18n.t('Finish signing in on the new tab, then return to this window.');changed(ctx);return;}
  if(this.kind==='early'){model.notice=deps.i18n.t('Ready in a moment. Select the button again.');changed(ctx);return;}
  if(model.busy||TERMINAL.includes(model.phase)&&this.kind!=='boot')return;
  model.busy=true;model.error='';changed(ctx);
  try{await this[this.kind]?.(deps,ctx,this.detail);}
  catch(error){if(['invalid_request','embed_attestation_required','embed_attestation_failed'].includes(error.code)&&!['continue','configure'].includes(this.kind)){phase(model,'expired');}model.error=failureMessage(error,deps.i18n.t);}
  finally{model.busy=false;changed(ctx);}
 }
 gate({model,secrets}){return model.mode==='embed'?{pageSecret:secrets.pageSecret}:model.mode==='plain'?{plain:true}:{};}
 async boot(deps,ctx){
  const {model,secrets,api,browser}=deps,parsed=parseEntryLocation(browser.location);
  if(browser.framed()){phase(model,'framed');return;}
  if(!parsed){phase(model,'invalid');return;}
  if(browser.sandboxed()){phase(model,'sandboxed');return;}
  model.entryId=parsed.entryId;
  let entry;try{entry=validEntryView(await api.get(`/api/oauth/entries/${parsed.entryId}`),browser.origin);}catch(error){phase(model,['rate_limited','temporarily_unavailable'].includes(error.code)?'unavailable':'expired');return;}
  if(entry.expiresAt<=browser.now()){phase(model,'expired');return;}
  if(entry.delivery==='embed-popup'&&!parsed.plain){
   // §7.3: nothing account-related renders in this COOP-less document until the opener proves the entry's key.
   phase(model,'handshake');changed(ctx);
   let manifest=null;if(!entry.embed.origin&&!entry.embed.attested&&!entry.embed.plain)try{manifest=await api.get('/.well-known/bindle/manifest.json');}catch{}
   const embedOrigin=entry.embed.attested||entry.embed.plain?null:embedOriginFor({entry,manifest,issuer:browser.origin});
   const pageSecret=embedOrigin?await runHandshake({win:browser.win,api,entryId:parsed.entryId,embedOrigin}):null;
   // No proof: replace this document with the COOP-isolated plain page, which severs the opener (AS-R2-1).
   if(!pageSecret){browser.replace(plainURL(parsed.entryId));return;}
   Object.assign(secrets,{pageSecret,embedOrigin});model.mode='embed';
  }else model.mode=entry.delivery==='embed-popup'?'plain':'standard';
  model.entry=entry;phase(model,entry.intent==='end-session'?'end-session':'choose');changed(ctx);
  await this.loadAccounts(deps,ctx);
 }
 async loadAccounts({model,api,browser},ctx){
  model.accountsLoading=true;changed(ctx);let accounts;
  try{
   try{accounts=parseAccounts(await api.get('/api/auth/accounts'));}
   catch(error){if(error.code==='invalid_accounts')throw error;
    // Without per-account cookies the provider keeps one legacy session; it has no member selector.
    const session=error.status===401?null:await api.get('/api/session').catch(()=>null);
    accounts=session?.authenticated&&UUID.test(session.account?.id??'')&&typeof session.account.handle==='string'?[Object.freeze({id:session.account.id,handle:session.account.handle,sessionContext:null,legacy:true})]:[];}
   model.accounts=eligibleAccounts(accounts,model.entry,browser.origin);
   // Only a boolean: some other account is signed in here, so a constrained entry can say "not as the requested account".
   model.otherAccounts=accounts.length>model.accounts.length;
  }finally{model.accountsLoading=false;changed(ctx);}
 }
 /** The chosen member's live CSRF, from that member's own session (the console's default is untouched). */
 async member({api},account){
  const session=await api.get('/api/session',{member:account});
  if(!session.authenticated||session.account?.id!==account.id||typeof session.csrfToken!=='string'||!session.csrfToken)fail('unauthorized','That account is no longer signed in.');
  return {id:account.id,sessionContext:account.legacy?null:session.sessionContext,legacy:account.legacy===true,csrf:session.csrfToken};
 }
 async continue(deps,ctx,{owner}){
  const {model,secrets,api,consent}=deps,account=model.accounts?.find(a=>a.id===owner),entry=model.entry;
  if(!account||!['choose','reauth'].includes(model.phase)||entry.intent==='end-session')return;
  let member;
  try{
   member=await this.member(deps,account);
   const {requestId}=await api.post(`/api/oauth/entries/${model.entryId}/select`,{nonce:entry.nonce,...this.gate(deps)},{member,csrf:member.csrf});
   if(typeof requestId!=='string'||!REQUEST.test(requestId)||!requestId.startsWith(owner+'.'))fail('request_failed','The request could not be completed.');
   secrets.member=member;model.selected={id:owner,handle:account.handle};model.reauth=null;model.notice='';
   const view=await this.inspect(deps,requestId);model.consent=view;model.selection.clear();model.drafts.clear();model.dirty.clear();
   // Identity-only sign-in: "Continue as …" (with the disclosure next to it) is the decision click.
   if(!view.requests.length){await this.decide(deps,ctx,[]);return;}
   phase(model,'consent');
  }catch(error){
   if(error.code==='reauthentication_required'){model.reauth={id:owner,handle:account.handle};phase(model,'reauth');model.surface++;return;}
   if(['unauthorized','account_context_conflict','session_context_conflict'].includes(error.code)){model.error=failureMessage(error,deps.i18n.t);await this.loadAccounts(deps,ctx).catch(()=>{});return;}
   throw error;
  }
 }
 async inspect({model,secrets,api},requestId){
  const view=await api.get(`/api/oauth/requests/${encodeURIComponent(requestId)}`,{member:secrets.member});
  if(view.authenticated!==true||view.client?.id!==model.entry.client.id||view.client?.origin!==model.entry.client.origin||!Array.isArray(view.requests))fail('request_failed','The request could not be completed.');
  return {...view,requestId};
 }
 async configure(deps,ctx,detail){
  const {model,secrets,api}=deps;if(model.phase!=='consent')return;
  await api.post('/api/preferences',{fragment:detail.fragment,values:detail.values,expectedRevision:detail.expectedRevision,reviewedConsumerDigest:detail.reviewedConsumerDigest,...detail.updateShared?{updateShared:true}:{}},{member:secrets.member,csrf:secrets.member?.csrf});
  model.consent=await this.inspect(deps,model.consent.requestId);model.selection.delete(detail.fragment);model.drafts.delete(detail.fragment);model.dirty.delete(detail.fragment);model.surface++;
 }
 async approve(deps,ctx){
  const {model,consent}=deps;if(model.phase!=='consent'||consent.approvalBlocked(model.consent))return;
  await this.decide(deps,ctx,consent.approvedSelections(model.consent));
 }
 async decide(deps,ctx,approved){
  const {model,secrets,api}=deps;
  const result=await api.post(`/api/oauth/entries/${model.entryId}/decision`,{nonce:model.entry.nonce,approved,...this.gate(deps)},{member:secrets.member,csrf:secrets.member?.csrf});
  await this.deliver(deps,ctx,result,'completed');
 }
 async cancel(deps,ctx){
  const {model,secrets,api}=deps;if(!model.entry||model.entry.intent==='end-session')return;
  // Before an account is chosen the cancel is anonymous: the server needs no owner and returns a generic denial.
  // Its CSRF header carries the entry nonce, which only a same-origin reader of the entry view has.
  const member=secrets.member;
  const result=await api.post(`/api/oauth/entries/${model.entryId}/decision`,{nonce:model.entry.nonce,denied:true,...this.gate(deps)},{member,csrf:member?.csrf??model.entry.nonce,anonymous:!member});
  await this.deliver(deps,ctx,result,'canceled');
 }
 async deliver(deps,ctx,result,outcome){
  const {model,secrets,browser}=deps,entry=model.entry,issuer=browser.origin;
  if(model.mode==='embed'){
   if(typeof result.code==='string'){
    if(!CODE.test(result.code)||typeof result.claim!=='string'||!CLAIM.test(result.claim)||result.iss!==issuer||typeof result.state!=='string')fail('callback_mismatch','The callback origin does not match this application.');
    phase(model,'returning');model.outcome=outcome;changed(ctx);
    if(await deliverToOpener({win:browser.win,embedOrigin:secrets.embedOrigin,entryId:model.entryId,result})){phase(model,'closed');changed(ctx);browser.close();return;}
    // §7.4: without an acknowledgement the code alone goes to the registered callback; the claim is dropped and the
    // opener is severed first so a late frame cannot interact with the navigated window.
    try{browser.win.opener=null;}catch{}
    const fallback=new URL(entry.redirectUri);for(const [k,v] of Object.entries({code:result.code,state:result.state,iss:result.iss}))fallback.searchParams.set(k,v);
    browser.assign(callbackTarget(fallback.href,entry.redirectUri,issuer,['code','state','iss']).href);return;
   }
   // A denial is reported by the frame as a generic cancel when this window closes.
   phase(model,'closed');model.outcome='canceled';changed(ctx);browser.close();return;
  }
  const target=callbackTarget(result.redirectUri,entry.redirectUri,issuer,entry.intent==='end-session'?['result','state','iss']:['code','state','iss','error']);
  phase(model,'returning');model.outcome=outcome;changed(ctx);browser.assign(target.href);
 }
 async 'end-session'(deps,ctx,{confirmed}){
  const {model,api}=deps;if(model.phase!=='end-session'||typeof confirmed!=='boolean')return;
  const account=model.accounts?.[0];let member=null;
  if(account&&confirmed)member=await this.member(deps,account);
  const result=await api.post(`/api/oauth/entries/${model.entryId}/end-session`,{nonce:model.entry.nonce,confirmed},{member,csrf:member?.csrf??model.entry.nonce,anonymous:!member});
  await this.deliver(deps,ctx,result,confirmed?'completed':'canceled');
 }
}

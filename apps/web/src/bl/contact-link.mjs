import {Action} from '../shared/stack.mjs';
import {interfaceText} from '../ui/interface-text.mjs';
import {accountInventory} from './accounts.mjs';
import {parseIdentity,discoverIdentity} from '../../../../packages/sdk/src/identity.mjs';
// Contact links (docs/spec/links.md §9). The public page only describes a link and
// hands off; sending happens inside the signed-in console. The capability stays in
// browser memory, owner operations sign only after a click, and every delivery
// carries an identity author proof (no anonymous branch).
const snapshot=r=>r.state.snapshot();
const publish=(r,ctx,patch)=>{r.state.transition(next=>Object.assign(next,patch));ctx.engineFeed.dispatchEvent(new Event('browser-state-updated'));};
const patch=(r,ctx,key,value)=>publish(r,ctx,{[key]:{...snapshot(r)[key],...value}});
const jws=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const intentLink=(intent,link)=>`web+bindle://${intent}?contact-url=${encodeURIComponent(link)}`;
export const writable=intake=>Boolean(intake?.mimeTypes?.some(t=>['text/plain','text/html'].includes(t)));
const failures={
 link_malformed:'This contact link is malformed. Ask the sender for a fresh link.',link_invalid:'This contact link is expired, revoked, or invalid.',unauthorized:'This contact link is expired, revoked, or invalid.',not_acceptable:'This contact link is expired, revoked, or invalid.',
 author_required:'Contact links now require a message from a signed-in identity.',author_unverifiable:'Your identity could not be verified for this link. Sign in again and retry.',
 audience_ineligible:'This contact link does not currently accept messages from your account.',audience_unavailable:'Eligibility could not be checked right now. Try again shortly.',audience_malformed:'The eligibility response was invalid. Try continuing again.',
 forbidden_tags:'The accepted tags changed. Review the updated choices and send again.',quota_exceeded:'This link’s message limit has been reached for now.',rate_limited:'Please wait before trying again.',
 too_large:'This message exceeds the link’s size limit.',body_too_large:'This message exceeds the link’s size limit.',unsupported_media:'This link does not accept that message type.',operation_conflict:'This message conflicts with an earlier send. Edit it and send again.',kind_forbidden:'This link does not accept this kind of message.'
};
const later={quota_exceeded:'This link’s message limit has been reached. Try again {time}.',rate_limited:'Please wait and try again {time}.'};
export const contactFailure=(error,locale='en')=>{if(error?.retryAfter&&later[error.code]){const minutes=Math.max(1,Math.ceil(error.retryAfter/60));return interfaceText(later[error.code],{time:new Intl.RelativeTimeFormat(locale,{numeric:'auto'}).format(minutes,'minute')});}return failures[error?.code]??(error?.message||'The request could not be completed. Please try again.');};
// The canonical audience origin comes from the captured meta's `aud`; the link's own origin is the fallback.
export function audienceOrigin(link){try{const url=new URL(link),meta=url.searchParams.get('bindle_meta');if(meta){const aud=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(meta.split('.')[1].replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-meta.split('.')[1].length%4)%4)),c=>c.charCodeAt(0)))).aud;const origin=new URL(aud).origin;if(origin===url.origin)return origin;}return url.origin;}catch{return null;}}
// Eligibility and sent state belong to the account that produced them; switching accounts never reuses them.
export const audienceOf=s=>s.handoff?.audience&&s.handoff.audience.owner===s.session?.account?.id?s.handoff.audience:null;
export const sentFor=s=>Boolean(s.handoff?.sent&&s.handoff.sent===s.session?.account?.id);
export const composable=s=>Boolean(s.session?.account&&s.handoff?.intent==='send-message'&&writable(s.handoff.intake)&&!sentFor(s)&&(!s.handoff.intake.conditional||audienceOf(s)?.state==='eligible'));
// Intake metadata is side-effect free; captured bindle_data is never evaluated (only an explicit Continue produces one).
export async function loadContact(r,ctx,endpoint,live,key){const intake=await r.api.contactIntake(endpoint,snapshot(r).locale);if(!live())return null;if(intake?.version!==1||!['link','legacy'].includes(intake.form)||!Array.isArray(intake.mimeTypes)||!Array.isArray(intake.optionalTags))throw new Error('This contact link returned an unexpected description.');patch(r,ctx,key,{intake});return intake;}
const audience=result=>{const state=result?.audience?.state;if(!['required','stale','unverifiable','unavailable','ineligible','eligible'].includes(state))throw new Error('Eligibility could not be checked right now. Try again shortly.');return {state,...typeof result.audience.reason==='string'&&/^[a-z-]{1,40}$/.test(result.audience.reason)?{reason:result.audience.reason}:{}};};
// Public page: description only (intake + optional owner profile + signup capacity). No messaging API.
export async function loadContactPage(r,ctx,endpoint,live){publish(r,ctx,{contactPage:{link:endpoint,intake:null,profile:null,signup:null}});const intake=await loadContact(r,ctx,endpoint,live,'contactPage');if(!intake)return;r.api.contactProfile(endpoint).then(profile=>{if(live()&&snapshot(r).contactPage?.intake===intake)patch(r,ctx,'contactPage',{profile});}).catch(()=>{});r.api.get('/api/signup/status',{context:null}).then(signup=>{if(live())patch(r,ctx,'contactPage',{signup:{open:signup?.signupOpen===true,free:signup?.freeSignupOpen===true,paid:signup?.paidSignupOpen===true,waitlist:signup?.waitlistEnabled===true}});}).catch(()=>{});}
class PublicFlow extends Action {
 static deps={state:{write:true},browser:{}};
 constructor(detail={}){super();this.detail=detail;}
 async execute(r,ctx){const s=snapshot(r),endpoint=r.browser.secret('contactEndpoint');if(s.route.kind!=='contact')return;if(!endpoint){publish(r,ctx,{error:'This contact link is incomplete. Open the original link again.'});return;}try{await this.perform(r,ctx,this.detail,endpoint);}catch(error){publish(r,ctx,{error:error.message});}}
}
// Signed in (found client-side): hand off into the console through the fragment.
export class ContactHandoff extends PublicFlow {async perform(r,ctx,d,endpoint){if(!['send-message','add-contact'].includes(d.intent)||!snapshot(r).session?.account)return;r.browser.navigate('/console#contact='+encodeURIComponent(endpoint)+'&intent='+d.intent);}}
// Signed out: carry {link} in session storage through sign-in or sign-up, then return straight into the console prompt.
// The capability left the address bar when the page opened, so a reload cannot recover a failed
// description; this retries it from memory. Read-only: no messaging API, no credentials.
export class ReloadContactPage extends PublicFlow {static deps={...PublicFlow.deps,api:{}};async perform(r,ctx,d,endpoint){const s=snapshot(r);if(s.contactPage?.intake||s.contactPage?.retrying)return;const live=()=>r.browser.secret('contactEndpoint')===endpoint&&snapshot(r).route.kind==='contact'&&snapshot(r).route.recipient===s.route.recipient;publish(r,ctx,{error:'',contactPage:{...snapshot(r).contactPage,retrying:true}});try{await loadContactPage(r,ctx,endpoint,live);}catch(error){if(live())publish(r,ctx,{error:contactFailure(error,snapshot(r).locale)});}finally{if(live())publish(r,ctx,{contactPage:{...snapshot(r).contactPage,retrying:false}});}}}
export class ContactAuth extends PublicFlow {async perform(r,ctx,d,endpoint){r.browser.saveContactHandoff({link:endpoint,intent:null});r.browser.navigate(d.mode==='signup'?'/console?signup=1':d.mode==='paid'?'/console?signup=1&plan=paid':'/console?signin=1');}}
// Handle on another provider: discovery reuses the SDK limits (HTTPS, size, timeout, no redirects, no credentials).
// Only a definite `features["intents.v1"]` declaration listing the intent with a same-origin login_endpoint
// enables a hand-off; unknown features are ignored, an invalid feature is absent, and any failure falls back.
export class DiscoverProvider extends PublicFlow {async perform(r,ctx,d,endpoint){const s=snapshot(r),local=s.config.localDevelopment===true,home=new URL(s.config.origin??location.origin).host,value=String(d.values?.handle??'').trim();patch(r,ctx,'contactPage',{provider:null,providerError:''});
 let identity;try{identity=parseIdentity(value,home,{allowInsecureLocalhost:local});}catch{patch(r,ctx,'contactPage',{providerError:'Enter a handle like alex@provider.example.'});return;}
 if(identity.host===home){await new ContactAuth({mode:'signin'}).perform(r,ctx,{mode:'signin'},endpoint);return;}
 const fail=()=>patch(r,ctx,'contactPage',{providerError:interfaceText('{host} could not be used for this contact link. Use a Bindle app link instead.',{host:'\u2066'+identity.host+'\u2069'})});
 try{const found=await discoverIdentity(value,{fetcher:r.browser.fetcher??fetch,allowInsecureLocalhost:local,defaultHost:home}),m=found.manifest,feature=m?.features&&typeof m.features==='object'&&!Array.isArray(m.features)?m.features['intents.v1']:undefined;if(found.kind!=='provider'||!Array.isArray(feature?.intents)||!feature.intents.length||typeof feature.login_endpoint!=='string')return fail();const login=new URL(feature.login_endpoint),supported=['send-message','add-contact'].filter(i=>feature.intents.includes(i)&&(i==='add-contact'||writable(s.contactPage?.intake)));
  if(login.href!==feature.login_endpoint||login.origin!==m.issuer||login.protocol!=='https:'&&!(local&&login.hostname==='localhost')||login.username||login.password||login.search||login.hash||!supported.length)return fail();patch(r,ctx,'contactPage',{provider:{host:identity.host,login:login.href,intents:supported}});}catch{fail();}}}
export class ContinueWithProvider extends PublicFlow {async perform(r,ctx,d,endpoint){const p=snapshot(r).contactPage?.provider;if(!p?.intents.includes(d.intent))return;r.browser.navigate(p.login+'?bindle_intent='+encodeURIComponent(intentLink(d.intent,endpoint)));}}
// Console handoff: one pending contact survives account choice; nothing is signed or sent on arrival.
export class StartHandoff extends Action {
 static deps={state:{write:true},api:{},browser:{}};
 async execute(r,ctx){const taken=r.browser.takeContactHandoff();if(!taken)return;if(taken.lost){publish(r,ctx,{notice:'The contact link from before sign-in has expired. Open it again to continue.'});return;}
  if(taken.foreign){publish(r,ctx,{handoff:{foreign:true,intent:taken.intent},view:'contact-send',error:''});return;}
  const s=snapshot(r);if(!s.session?.account){r.browser.saveContactHandoff(taken);publish(r,ctx,{...s.route?.auth==='signup'?{}:{auth:'login'},notice:'Sign in or create an account to send a message or add this contact.'});return;}
  r.browser.storeSecret('contactEndpoint',taken.link);publish(r,ctx,{handoff:{intent:taken.intent,link:taken.link,origin:audienceOrigin(taken.link),intake:null,audience:null,sent:null,choosing:false},error:''});
  try{await accountInventory(r,ctx);}catch{}if((snapshot(r).browserAccounts?.accounts?.length??0)>1){patch(r,ctx,'handoff',{choosing:true});publish(r,ctx,{accountPicker:true});return;}
  await proceed(r,ctx);}
}
async function proceed(r,ctx){const s=snapshot(r),h=s.handoff,endpoint=r.browser.secret('contactEndpoint');if(!h||!endpoint||!s.session?.account)return;
 if(h.intent==='add-contact'){r.browser.storeSecret('addContactURL',endpoint);publish(r,ctx,{handoff:null});ctx.engineFeed.dispatchEvent(new Event('add-contact-opened'));return;}
 publish(r,ctx,{view:'contact-send',modal:null,selected:null});r.browser.focus?.('.contact-handoff h1');const owner=s.session.account.id,live=()=>snapshot(r).session?.account?.id===owner&&r.browser.secret('contactEndpoint')===endpoint&&Boolean(snapshot(r).handoff);
 try{await loadContact(r,ctx,endpoint,live,'handoff');}catch(error){if(live())publish(r,ctx,{error:contactFailure(error,snapshot(r).locale)});}}
// After the account choice (stay or switch), continue with the same pending contact.
export class ProceedHandoff extends Action {static deps={state:{write:true},api:{},browser:{}};async execute(r,ctx){if(!snapshot(r).handoff)return;patch(r,ctx,'handoff',{choosing:false});publish(r,ctx,{accountPicker:false});await proceed(r,ctx);}}
export class ChooseHandoff extends Action {static deps={state:{write:true},api:{},browser:{}};constructor(d={}){super();this.detail=d;}async execute(r,ctx){if(!snapshot(r).handoff||!['send-message','add-contact'].includes(this.detail.intent))return;patch(r,ctx,'handoff',{intent:this.detail.intent});await proceed(r,ctx);}}
export class CancelHandoff extends Action {static deps={state:{write:true},browser:{}};async execute(r,ctx){r.browser.storeSecret('contactEndpoint',null);publish(r,ctx,{handoff:null,view:'inbox'});}}
export class WriteAnother extends Action {static deps={state:{write:true}};async execute(r,ctx){if(snapshot(r).handoff)patch(r,ctx,'handoff',{sent:null});}}
class ContactFlow extends Action {
 static deps={state:{write:true},api:{},browser:{}};
 constructor(detail={}){super();this.detail=detail;}
 async execute(r,ctx){const s=snapshot(r);if(s.handoff?.intent!=='send-message'||!s.session?.account||s.offline)return;const endpoint=r.browser.secret('contactEndpoint');if(!endpoint){publish(r,ctx,{error:'This contact link is incomplete. Open the original link again.'});return;}if(!r.state.reserve())return;
  const owner=s.session.account.id,generation=s.beamGeneration??0,live=()=>Boolean(snapshot(r).handoff)&&snapshot(r).session?.account?.id===owner&&(snapshot(r).beamGeneration??0)===generation&&r.browser.secret('contactEndpoint')===endpoint;ctx.engineFeed.dispatchEvent(new Event('browser-state-updated'));
  try{const values=this.detail.operationId?r.browser.consumeSubmission(this.detail.operationId):this.detail.values;await this.perform(r,ctx,{...this.detail,values},endpoint,live,owner);}catch(error){if(live()){publish(r,ctx,{error:contactFailure(error,snapshot(r).locale)});if(error.code==='forbidden_tags')await loadContact(r,ctx,endpoint,live,'handoff').catch(()=>{});}}finally{publish(r,ctx,{busy:false});}}
}
export class ReloadContact extends ContactFlow {async perform(r,ctx,d,endpoint,live){patch(r,ctx,'handoff',{audience:null});await loadContact(r,ctx,endpoint,live,'handoff');}}
// Explicit "Continue as": the owner host signs a response for the selected account, then the public inspection evaluates it once.
export class ContinueAsAudience extends ContactFlow {async perform(r,ctx,d,endpoint,live,owner){const h=snapshot(r).handoff;if(!h.intake?.conditional||!writable(h.intake)||!endpoint.includes('?bindle_meta='))return;const signed=await r.api.request('/api/links/respond',{link:endpoint});if(!live())return;if(typeof signed?.data!=='string'||!jws.test(signed.data))throw new Error('Your identity response could not be created. Try again.');const result=await r.api.contactInspect(endpoint,signed.data);if(live())patch(r,ctx,'handoff',{audience:{...audience(result),owner}});}}
export class SendAuthoredMessage extends ContactFlow {async perform(r,ctx,d,endpoint,live,owner){
 const s=snapshot(r),h=s.handoff,intake=h.intake,v=d.values??{};if(!composable(s))throw new Error('Sign in and confirm eligibility before sending.');
 const mimeType=intake.mimeTypes.includes(v.mimeType)&&['text/plain','text/html'].includes(v.mimeType)?v.mimeType:intake.mimeTypes.find(t=>['text/plain','text/html'].includes(t));
 const text=typeof v.text==='string'?v.text:'',subject=typeof v.subject==='string'?v.subject.trim():'',allowed=intake.optionalTags.map(t=>t.id),tags=[...new Set((Array.isArray(v.tags)?v.tags:v.tags?[v.tags]:[]).filter(t=>typeof t==='string'))];
 if(!text.trim())throw new Error('Write a message before sending.');if(subject.length>200||/[\u0000-\u001f\u007f]/.test(subject))throw new Error('Use a subject of up to 200 characters without line breaks.');if(tags.some(t=>!allowed.includes(t)))throw new Error('The accepted tags changed. Review the updated choices and send again.');
 const body=await r.browser.messageBody(text,mimeType);if(body.bytes.byteLength>intake.maxMessageBytes)throw new Error('This message exceeds the link’s size limit.');
 // An identical retry keeps its operation ID and signed creation time, so an unknown earlier outcome is reconciled, never duplicated.
 const fingerprint=JSON.stringify([owner,mimeType,subject,[...tags].sort(),body.sha256]),retry=h.sendFingerprint===fingerprint&&h.sendOperation,operationId=retry?h.sendOperation:r.browser.id(),createdAt=retry&&Number.isSafeInteger(h.sendCreatedAt)?h.sendCreatedAt:r.browser.now();patch(r,ctx,'handoff',{sendFingerprint:fingerprint,sendOperation:operationId,sendCreatedAt:createdAt});
 const signed=await r.api.request('/api/links/envelope',{link:endpoint,mimeType,subject,optionalTags:tags,byteLength:body.bytes.byteLength,sha256:body.sha256,operationId,createdAt});if(!live())return;
 if(signed?.envelope?.payload?.operationId!==operationId||signed.envelope.payload.content?.sha256!==body.sha256||signed.envelope.payload.content?.mimeType!==mimeType)throw new Error('Your message could not be prepared. Try again.');
 const result=await r.api.contactDeliver(endpoint,signed.envelope,body.bytes);if(!live())return;if(!result?.receipt?.payload)throw new Error('The service did not confirm delivery. Send again to check.');
 patch(r,ctx,'handoff',{sent:owner,sendFingerprint:null,sendOperation:null,sendCreatedAt:null});r.browser.focus?.('.contact-sent h3');
}}

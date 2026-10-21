// Contacts: owner-issued contact parents (spec §4; links contract issue/revoke), contacts added from another person's
// contact link, and principal blocks. Parent changes publish to the edge index transactionally (store/edge-index.mjs).
// Network calls to the links contract run outside every transaction; local revocation commits first, so this
// mailbox refuses a revoked link even while the provider call is pending or failing.
import {CONTACT_LINK_TYPE,LINK_KINDS,parseCompact,base64url} from '../../bindlebox-protocol/index.mjs';
import {MailboxAction,MailboxQuery} from '../engine.mjs';
import {fault} from '../faults.mjs';
import {KEYS,BOUNDS,actorOwner,readConfig,queueEdge,principalKey} from '../store/mailbox.mjs';
import {claimsDigest,LINK_META_TYPE} from '../store/edge-index.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MIME=/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const invalid=(message='The contact link is not valid.')=>fault('invalid_input',message,400);
const int=(v,max)=>Number.isSafeInteger(v)&&v>0&&v<=max;
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(v);
const pdecode=name=>name.replace(/%[0-9A-Fa-f]{2}/g,m=>String.fromCharCode(parseInt(m.slice(1),16)));
// Links §2 raw-query parser (one parser for every route decision): exactly one `bindle_meta`, no other Bindle
// parameter, no legacy `sig`. Returns {meta, data, canonical} where canonical drops unrelated parameters.
export function parseLinkURL(input){
 if(typeof input!=='string'||input.length>8192)invalid();
 let url;try{url=new URL(input);}catch{invalid();}
 if(url.protocol!=='https:'||url.username||url.password)invalid();
 const hash=input.indexOf('#'),q=input.indexOf('?'),raw=q<0?'':input.slice(q+1,hash<0||hash<q?undefined:hash);
 let meta,data,legacy=false;
 for(const component of raw.split('&')){
  if(!component)continue;const eq=component.indexOf('='),name=eq<0?component:component.slice(0,eq),value=eq<0?undefined:component.slice(eq+1),lower=pdecode(name).toLowerCase();
  if(lower==='sig')legacy=true;
  if(!lower.startsWith('bindle_'))continue;
  if(name!=='bindle_meta'&&name!=='bindle_data')invalid();
  if(!value||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))invalid();
  if(name==='bindle_meta'){if(meta!==undefined)invalid();meta=value;}else{if(data!==undefined)invalid();data=value;}
 }
 if(!meta||legacy||meta.length>4096||(data&&data.length>2048))invalid();
 return {meta,data,url,canonical:`${url.origin}${url.pathname}?bindle_meta=${meta}`};
}
// Exact received segments and decoded claims of a contact-type meta. Structural only (tooling rules, links §5): the
// issuer's signature cannot be verified by a non-owner in this version, so a contact's principal is a claim.
export function contactMeta(meta){
 let jws;try{jws=parseCompact(meta,LINK_META_TYPE);}catch{invalid();}
 const c=jws.claims;
 if(c.bindle!=='link-meta'||c.v!==1||c.type!==CONTACT_LINK_TYPE||typeof c.iss!=='string'||typeof c.aud!=='string'||typeof c.jti!=='string'||!c.jti||c.jti.length>128||!UUID.test(c.sub)||typeof c.resource!=='string'||c.resource.length>128)invalid();
 if(!Array.isArray(c.kinds)||!c.kinds.length||c.kinds.some((k,i)=>!LINK_KINDS.includes(k)||(i&&!(c.kinds[i-1]<k))))invalid();
 if(!Number.isSafeInteger(c.iat)||!Number.isSafeInteger(c.exp)||c.iat>=c.exp)invalid();
 return {jws,claims:c,segments:meta.split('.').slice(0,2).join('.')};
}
const parentView=p=>({jti:p.jti,resource:p.resource,label:p.label??null,kinds:p.kinds,mimeTypes:p.mimeTypes,public:p.public,conditional:p.conditional,revoked:p.revoked,providerRevoke:p.providerRevoke??null,createdAt:p.createdAt,expiresAt:p.claims.exp*1000,link:p.revoked?null:p.link});
const contactView=c=>({id:c.id,label:c.label??null,principal:c.principal,verified:false,kinds:c.kinds,conditional:c.conditional,expiresAt:c.expiresAt,addedAt:c.addedAt,link:c.link});
const principalInput=p=>{if(!p||typeof p!=='object'||typeof p.issuer!=='string'||!/^https:\/\/[^/?#]+$/.test(p.issuer)||!UUID.test(p.subject))invalid('Choose a valid principal.');return {issuer:p.issuer,subject:p.subject};};

// Issues a contact parent through the provider's links contract and records the exact issued claims.
export class ContactsCreateLink extends MailboxAction {
 static operation='contacts.create-link';static deps=['contacts','providerLink','random','clock'];static changes='contacts-changed';
 async run({contacts,providerLink,random,clock}){
  actorOwner(this.actor);const input=this.input??{},config=await readConfig(contacts.store);
  const kinds=input.kinds??['one-off'],mimeTypes=input.mimeTypes??['text/plain'];
  if(!Array.isArray(kinds)||!kinds.length||kinds.some((k,i)=>!LINK_KINDS.includes(k)||(i&&!(kinds[i-1]<k))))invalid('Choose message kinds.');
  if(!Array.isArray(mimeTypes)||!mimeTypes.length||mimeTypes.length>16||mimeTypes.some(m=>!MIME.test(m)))invalid('Choose message types.');
  const limits={maxMessages:input.maxMessages??100,maxBytes:input.maxBytes??16*1048576,maxMessageBytes:input.maxMessageBytes??1048576};
  if(!int(limits.maxMessages,1e6)||!int(limits.maxBytes,2**40)||!int(limits.maxMessageBytes,1048576))invalid('Choose valid limits.');
  if(input.label!==undefined&&!text(input.label,80))invalid('Choose a shorter label.');
  const conditional=input.conditional===true,resource=random.uuid();
  const claims={sub:config.principal.subject,resource,kinds,mimeTypes,...limits,...conditional?{audience:{challenge:base64url(random.bytes(16)),...typeof input.policy==='string'?{policy:input.policy}:{}}}:{}};
  if(!providerLink||typeof providerLink.issue!=='function')fault('links_unavailable','Your provider cannot issue contact links.',503);
  const issued=await providerLink.issue({type:CONTACT_LINK_TYPE,claims});
  const {meta}=parseLinkURL(issued?.link),parsed=contactMeta(meta),c=parsed.claims;
  // The issued meta must carry exactly what was requested, for this owner, under the returned jti.
  if(c.jti!==issued.jti||c.iss!==config.principal.issuer||c.sub!==claims.sub||c.resource!==resource||JSON.stringify(c.kinds)!==JSON.stringify(kinds)||JSON.stringify(c.mimeTypes)!==JSON.stringify(mimeTypes)||c.maxMessages!==limits.maxMessages||c.maxBytes!==limits.maxBytes||c.maxMessageBytes!==limits.maxMessageBytes||Boolean(c.audience)!==conditional)fault('links_unavailable','Your provider returned an unexpected link.',502);
  const digest=await claimsDigest(meta),now=clock.now();
  const parent={jti:c.jti,iss:c.iss,resource,label:input.label??null,header:parsed.jws.header,claims:c,segments:parsed.segments,claimsDigest:digest,kinds,mimeTypes,...limits,conditional,public:conditional||input.public===true,revoked:false,createdAt:now,usage:{messages:0,bytes:0},link:issued.link};
  await contacts.store.transaction(async tx=>{
   if(await tx.get(KEYS.parent(c.jti)))fault('conflict','That link already exists.',409);
   if((await tx.list({prefix:'parent/'})).size>=BOUNDS.maxParents)fault('limit_reached','Too many contact links.',409);
   await tx.put(KEYS.parent(c.jti),parent);await queueEdge(tx,{iss:c.iss,jti:c.jti,claimsDigest:digest,revoked:false});
  });
  return parentView(parent);
 }
}
// Owner revocation: local first (edge entry and mailbox refuse at once), then the provider; a failed provider call
// leaves `providerRevoke: 'pending'` for a later retry and never undoes the local revocation.
export class ContactsRevokeLink extends MailboxAction {
 static operation='contacts.revoke-link';static deps=['contacts','providerLink','clock'];static changes='contacts-changed';
 async run({contacts,providerLink,clock}){
  const kind=this.actor?.kind==='system'?'system':'owner';actorOwner(this.actor,[kind]);const jti=this.input?.jti;if(typeof jti!=='string'||!jti||jti.length>128)invalid('Choose a link.');
  const fromProvider=kind==='system';let parent;
  await contacts.store.transaction(async tx=>{
   parent=await tx.get(KEYS.parent(jti));if(!parent)fault('not_found','That link does not exist.',404);
   if(!parent.revoked){parent={...parent,revoked:true,revokedAt:clock.now(),providerRevoke:fromProvider?'revoked':'pending'};await tx.put(KEYS.parent(jti),parent);await queueEdge(tx,{iss:parent.iss,jti,claimsDigest:parent.claimsDigest,revoked:true});}
   for(const [key] of await tx.list({prefix:`decision/${encodeURIComponent(jti)}/`}))await tx.delete(key);
  });
  if(parent.providerRevoke==='pending'&&providerLink&&typeof providerLink.revoke==='function'){
   try{await providerLink.revoke({jti});await contacts.store.transaction(async tx=>{const current=await tx.get(KEYS.parent(jti));if(current?.revoked)await tx.put(KEYS.parent(jti),{...current,providerRevoke:'revoked'});});parent={...parent,providerRevoke:'revoked'};}catch{/* retried by the next revoke call */}
  }
  return parentView(parent);
 }
}
// Adds another person's contact link to the address book. The link is stored canonically (unrelated parameters and
// any bindle_data dropped); its principal is the meta's unverified claim, used for display and request triage only.
export class ContactsAdd extends MailboxAction {
 static operation='contacts.add';static deps=['contacts','random','clock'];static changes='contacts-changed';
 async run({contacts,random,clock}){
  actorOwner(this.actor);const input=this.input??{},{meta,url,canonical}=parseLinkURL(input.link),{claims:c}=contactMeta(meta),now=clock.now();
  if(c.iss!==url.origin||c.aud!==`${url.origin}${url.pathname}`)invalid();
  if(c.exp*1000<=now)invalid('That contact link has expired.');
  if(input.label!==undefined&&!text(input.label,80))invalid('Choose a shorter label.');
  const config=await readConfig(contacts.store);if(c.iss===config.principal.issuer&&c.sub===config.principal.subject)invalid('That is your own contact link.');
  const principal={issuer:c.iss,subject:c.sub},index=`contact-link/${encodeURIComponent(c.iss)}/${encodeURIComponent(c.jti)}`;
  return contacts.store.transaction(async tx=>{
   const existing=await tx.get(index);if(existing){const prior=await tx.get(KEYS.contact(existing));if(prior)return contactView(prior);}
   if((await tx.list({prefix:'contact/'})).size>=BOUNDS.maxContacts)fault('limit_reached','Too many contacts.',409);
   const contact={id:random.uuid(),label:input.label??null,principal,jti:c.jti,kinds:c.kinds,conditional:Boolean(c.audience),expiresAt:c.exp*1000,addedAt:now,link:canonical};
   await tx.put(KEYS.contact(contact.id),contact);await tx.put(index,contact.id);
   const known=await tx.get(`known/${principalKey(principal)}`);await tx.put(`known/${principalKey(principal)}`,{principal,contacts:[...new Set([...(known?.contacts??[]),contact.id])]});
   return contactView(contact);
  });
 }
}
export class ContactsRemove extends MailboxAction {
 static operation='contacts.remove';static deps=['contacts'];static changes='contacts-changed';
 async run({contacts}){
  actorOwner(this.actor);const id=this.input?.id;if(!UUID.test(id??''))invalid('Choose a contact.');
  return contacts.store.transaction(async tx=>{
   const contact=await tx.get(KEYS.contact(id));if(!contact)fault('not_found','That contact does not exist.',404);
   await tx.delete(KEYS.contact(id));await tx.delete(`contact-link/${encodeURIComponent(contact.principal.issuer)}/${encodeURIComponent(contact.jti)}`);
   const key=`known/${principalKey(contact.principal)}`,known=await tx.get(key),rest=(known?.contacts??[]).filter(x=>x!==id);
   if(rest.length)await tx.put(key,{...known,contacts:rest});else await tx.delete(key);return {id,removed:true};
  });
 }
}
// Blocking a principal refuses its deliveries on every link and invalidates reused audience decisions (S-20).
export class ContactsBlock extends MailboxAction {
 static operation='contacts.block';static deps=['contacts','clock'];static changes='contacts-changed';
 async run({contacts,clock}){
  actorOwner(this.actor);const principal=principalInput(this.input?.principal),blocked=this.input?.blocked!==false,pk=principalKey(principal);
  await contacts.store.transaction(async tx=>{
   if(blocked)await tx.put(KEYS.block(principal),{principal,at:clock.now()});else await tx.delete(KEYS.block(principal));
   for(const [key] of await tx.list({prefix:'decision/'}))if(key.endsWith(`/${pk}`))await tx.delete(key);
  });
  return {principal,blocked};
 }
}
export class ContactsList extends MailboxQuery {
 static operation='contacts.list';static deps=['contacts'];static refreshOn=['contacts-changed'];
 async fetch({contacts}){actorOwner(this.actor);return {contacts:[...(await contacts.store.list({prefix:'contact/'})).values()].map(contactView),links:[...(await contacts.store.list({prefix:'parent/'})).values()].map(parentView)};}
}
export const CONTACT_OPERATIONS=[ContactsCreateLink,ContactsRevokeLink,ContactsAdd,ContactsRemove,ContactsBlock,ContactsList];

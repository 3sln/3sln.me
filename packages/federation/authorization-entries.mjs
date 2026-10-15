// Provider-owned authorization entry (embeddable-elements D1/S4, adaptive-app-sign-in §7.1–7.4). A cookieless,
// pre-owner record pins client, exact callback, PKCE S256, state, scopes, intent, a server nonce and expiry before
// any account is chosen. Owner selection durably records owner, session and the new owner-request ID before the
// owner shard can issue a redeemable approval; retries resume that same request. Entries are stored by hash only.
import {digest,base64url,boundedString,canonical} from '../messaging/store.mjs';
import {fail,object,exact,https} from './schema.mjs';
import {verifyProof,EMBED_PROOF_TYP,jktPattern} from './dpop.mjs';
import {componentsDeclaration,COMPONENTS_PROFILE} from './components-profile.mjs';
export const ENTRY_INTENTS=['login','select-account','reauthenticate','end-session'];
export const ENTRY_LIMITS={ttl:600000,challenge:60000,window:600000,perClient:30,perRemote:60,global:20000,challenges:3};
const entryKeys=['clientId','redirectUri','challenge','challengeMethod','state','intent','loginHint','subjectConstraint','maxAge','requests','uiLocales','colorScheme','presentation','dpopJkt','embedJkt','delivery'];
const ID=/^[A-Za-z0-9_-]{43}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const generic=()=>fail('invalid_request','The authorization entry could not be created.');
const expired=()=>fail('invalid_request','This sign-in expired. Start again from the application.');
const random=(crypto,size=32)=>base64url(crypto.getRandomValues(new Uint8Array(size)));
/** Core `authorization-entry.v1` feature (protocol §2), advertised only where the entry routes are mounted. */
export function entryManifest(issuer,{intents=ENTRY_INTENTS.slice(0,3)}={}){return {features:{'authorization-entry.v1':{endpoint:`${issuer}/api/oauth/entries`,intents:[...intents]}}};}
export const ownerOf=context=>{const owner=context?.expectedOwner??(typeof context?.sessionToken==='string'?context.sessionToken.split('.')[0]:'');return UUID.test(owner)?owner:null;};
export class AuthorizationEntries {
 constructor({store,issuer,clients=[],authority,embedOrigin,crypto=globalThis.crypto,clock=()=>Date.now(),dpop=false,pinSchema,endSession,limits={}}){
  if(!store?.transaction||!authority)throw new TypeError('Entry storage and the federation authority are required.');
  if(embedOrigin!==undefined&&(new URL(embedOrigin).origin!==embedOrigin||embedOrigin===issuer))throw new TypeError('The embed origin must be a dedicated origin.');
  Object.assign(this,{store,issuer,authority,embedOrigin,crypto,clock,dpop:dpop===true,pinSchema,endSession,limits:{...ENTRY_LIMITS,...limits}});
  this.clients=new Map(clients.map(client=>[client.id,client]));
 }
 intents(){return ENTRY_INTENTS.filter(intent=>intent!=='end-session'||typeof this.endSession==='function');}
 /** Manifest members for mounted entry routes. The components profile also needs DPoP (embed proofs) and an adapter
  * that actually serves the embed origin, which only the root adapter knows (`components`). */
 manifest({components=false}={}){const entry=entryManifest(this.issuer,{intents:this.intents()});return components&&this.embedOrigin&&this.dpop?{...entry,...componentsDeclaration({profile:COMPONENTS_PROFILE,embedOrigin:this.embedOrigin})}:entry;}
 hash(entryId){if(typeof entryId!=='string'||!ID.test(entryId))expired();return digest(this.crypto,`authorization-entry\0${entryId}`);}
 async budget(tx,scope,limit){const window=Math.floor(this.clock()/this.limits.window),name=`budget/${scope}/${window}`,record=await tx.get(name)??{count:0,expiresAt:(window+2)*this.limits.window};if(record.count>=limit)fail('rate_limited','Too many sign-in attempts. Try again shortly.');record.count++;await tx.set(name,record);}
 validRequests(requests,intent){
  if(!Array.isArray(requests)||requests.length>8||intent==='end-session'&&requests.length||new TextEncoder().encode(canonical(requests)).length>16384)generic();const seen=new Set();
  for(const request of requests){if(!object(request)||Object.keys(request).some(k=>!['fragment','required','purpose','fields','methods'].includes(k))||typeof request.required!=='boolean'||!boundedString(request.purpose,1000)||!Array.isArray(request.fields)||!request.fields.length||request.fields.length>32||request.fields.some(f=>!boundedString(f,200))||new Set(request.fields).size!==request.fields.length||request.methods!==undefined&&!object(request.methods)||seen.has(request.fragment))generic();try{https(request.fragment);}catch{generic();}seen.add(request.fragment);}
  return structuredClone(requests);
 }
 /** Cookieless creation. `origin` is the browser-set Origin; only the embed origin may create embed entries. */
 async create(input,{origin,remote}={}){
  if(!object(input)||Object.keys(input).some(k=>!entryKeys.includes(k)))generic();
  const client=this.clients.get(input.clientId),embed=input.delivery!==undefined;
  if(!client?.redirectUris?.includes(input.redirectUri)||input.challengeMethod!=='S256'||typeof input.challenge!=='string'||!ID.test(input.challenge)||typeof input.state!=='string'||!/^[A-Za-z0-9._~-]{16,512}$/.test(input.state)||!this.intents().includes(input.intent)||!['redirect','popup'].includes(input.presentation))generic();
  if(embed?input.delivery!=='embed-popup'||!this.embedOrigin||origin!==this.embedOrigin||input.presentation!=='popup'||input.intent==='end-session'||!jktPattern.test(input.embedJkt??''):input.embedJkt!==undefined||origin!==undefined&&origin!==client.origin)generic();
  const constrained=['reauthenticate','end-session'].includes(input.intent);
  if(constrained!==(input.subjectConstraint!==undefined)||constrained&&(typeof input.subjectConstraint!=='string'||!input.subjectConstraint.startsWith(`${this.issuer}/entities/`)||!UUID.test(input.subjectConstraint.slice(this.issuer.length+10))))generic();
  if((input.intent==='reauthenticate')!==(input.maxAge!==undefined)||input.maxAge!==undefined&&(!Number.isSafeInteger(input.maxAge)||input.maxAge<0||input.maxAge>86400))generic();
  if(input.dpopJkt!==undefined&&(!this.dpop||input.intent==='end-session'||!jktPattern.test(input.dpopJkt)))generic();
  if(input.loginHint!==undefined&&!boundedString(input.loginHint,320)||input.colorScheme!==undefined&&!['light','dark'].includes(input.colorScheme)||input.uiLocales!==undefined&&(!Array.isArray(input.uiLocales)||input.uiLocales.length>4||input.uiLocales.some(tag=>typeof tag!=='string'||tag.length>35||!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(tag))))generic();
  const requests=this.validRequests(input.requests,input.intent);let digests;
  if(this.pinSchema&&requests.length){try{digests=await Promise.all(requests.map(async r=>(await this.pinSchema(r.fragment)).digest));}catch{generic();}}
  // A hint naming another host is ignored, never resolved at creation.
  const hint=input.loginHint?.split('@'),loginHint=hint?.length===2&&hint[1].toLowerCase()===new URL(this.issuer).host?input.loginHint:undefined;
  const entryId=random(this.crypto),now=this.clock(),record={v:1,clientId:input.clientId,redirectUri:input.redirectUri,challenge:input.challenge,state:input.state,intent:input.intent,requests,...digests?{digests}:{},presentation:input.presentation,delivery:embed?'embed-popup':input.presentation,...loginHint?{loginHint}:{},...constrained?{subjectConstraint:input.subjectConstraint}:{},...input.maxAge!==undefined?{maxAge:input.maxAge}:{},...input.uiLocales?.length?{uiLocales:[...input.uiLocales]}:{},...input.colorScheme?{colorScheme:input.colorScheme}:{},...input.dpopJkt?{dpopJkt:input.dpopJkt}:{},...embed?{embedJkt:input.embedJkt}:{},nonce:random(this.crypto,16),createdAt:now,expiresAt:now+this.limits.ttl};
  // Unauthenticated creation is budgeted per caller address, per client from that address and globally, so one
  // caller cannot drain another client's budget. Adapters must supply a (pseudonymous) remote address.
  if(typeof remote!=='string'||!remote)fail('temporarily_unavailable','Application sign-in is not available.');
  const hash=await this.hash(entryId),remoteKey=await digest(this.crypto,`entry-remote\0${remote}`),clientKey=await digest(this.crypto,`entry-client\0${input.clientId}\0${remote}`);
  await this.store.transaction(async tx=>{await this.budget(tx,'global',this.limits.global);await this.budget(tx,`remote/${remoteKey}`,this.limits.perRemote);await this.budget(tx,`client/${clientKey}`,this.limits.perClient);await tx.set(`entry/${hash}`,record);});
  return {entryId};
 }
 async load(tx,hash){const record=await tx.get(`entry/${hash}`);if(!record||record.expiresAt<=this.clock()||record.completed)expired();return record;}
 /** Session-independent request metadata for the static provider page. */
 async view(entryId){
  const hash=await this.hash(entryId),record=await this.store.transaction(tx=>this.load(tx,hash)),client=this.clients.get(record.clientId);if(!client)expired();
  return {entry:{client:{id:client.id,name:client.name,origin:client.origin},redirectUri:record.redirectUri,intent:record.intent,requests:structuredClone(record.requests),presentation:record.presentation,delivery:record.delivery,nonce:record.nonce,expiresAt:record.expiresAt,...record.loginHint?{loginHint:record.loginHint}:{},...record.subjectConstraint?{subjectConstraint:record.subjectConstraint}:{},...record.maxAge!==undefined?{maxAge:record.maxAge}:{},...record.uiLocales?{uiLocales:record.uiLocales}:{},...record.colorScheme?{colorScheme:record.colorScheme}:{},...record.delivery==='embed-popup'?{embed:{attested:!!record.attested,plain:!!record.plain}}:{}}};
 }
 /** COOP class of the static entry document (§9). Unknown entries get the strict page. */
 async documentPolicy(entryId,mode){if(mode!==undefined&&mode!=='plain')return 'same-origin';let record=null;try{const hash=await this.hash(entryId);record=await this.store.transaction(tx=>tx.get(`entry/${hash}`));}catch{}return record&&record.expiresAt>this.clock()&&record.delivery==='embed-popup'&&!record.plain&&mode!=='plain'?'unsafe-none':'same-origin';}
 async challenge(entryId){
  const hash=await this.hash(entryId);
  return this.store.transaction(async tx=>{const record=await this.load(tx,hash);if(record.delivery!=='embed-popup'||record.plain||record.attested||record.selection||(record.challenges??0)>=this.limits.challenges)fail('embed_attestation_failed','This window cannot continue in the embedded sign-in.');const challenge=random(this.crypto,16);Object.assign(record,{challenges:(record.challenges??0)+1,challengeHash:await digest(this.crypto,`embed-challenge\0${challenge}`),challengeExpiresAt:Math.min(this.clock()+this.limits.challenge,record.expiresAt)});await tx.set(`entry/${hash}`,record);return {challenge};});
 }
 /** Opener-key handshake (§7.3): proof of the entry's embedJkt over a single-use challenge. */
 async verify(entryId,input){
  exact(input,['proof']);const hash=await this.hash(entryId),record=await this.store.transaction(tx=>this.load(tx,hash)),refuse=()=>fail('embed_attestation_failed','This window cannot continue in the embedded sign-in.');
  if(record.delivery!=='embed-popup'||record.plain||record.attested||!record.challengeHash)refuse();
  let proof;try{proof=await verifyProof(this.crypto,input.proof,{typ:EMBED_PROOF_TYP,htm:'POST',htu:`${this.issuer}/oauth/entries/${entryId}/embed-verify`,now:this.clock(),claims:{entry:entryId},nonce:async value=>{if(typeof value!=='string'||await digest(this.crypto,`embed-challenge\0${value}`)!==record.challengeHash||record.challengeExpiresAt<=this.clock())fail('invalid');return {hash:record.challengeHash,expiresAt:record.challengeExpiresAt};}});}catch{refuse();}
  if(proof.jkt!==record.embedJkt)refuse();
  const pageSecret=random(this.crypto),pageHash=await digest(this.crypto,`embed-page\0${pageSecret}`);
  await this.store.transaction(async tx=>{const current=await this.load(tx,hash);if(current.plain||current.attested||current.challengeHash!==record.challengeHash||current.challengeExpiresAt<=this.clock())refuse();delete current.challengeHash;delete current.challengeExpiresAt;current.attested={pageHash,at:this.clock()};await tx.set(`entry/${hash}`,current);});
  return {pageSecret};
 }
 /** Embed entries need the attested page's secret, or an irreversible plain-mode declaration. */
 async gate(tx,hash,record,{pageSecret,plain},persist=true){
  if(record.delivery!=='embed-popup'){if(pageSecret!==undefined||plain!==undefined&&plain!==true)fail('invalid_request');return;}
  if(record.attested){if(typeof pageSecret!=='string'||await digest(this.crypto,`embed-page\0${pageSecret}`)!==record.attested.pageHash)fail('embed_attestation_required','Reopen sign-in from the application.');return;}
  if(pageSecret!==undefined)fail('embed_attestation_required','Reopen sign-in from the application.');
  if(!record.plain){if(plain!==true)fail('embed_attestation_required','Reopen sign-in from the application.');if(!persist)return;record.plain=true;delete record.challengeHash;await tx.set(`entry/${hash}`,record);}
 }
 async select(entryId,context,input){
  exact(input,['nonce','plain','pageSecret']);const hash=await this.hash(entryId);
  const record=await this.store.transaction(async tx=>{const record=await this.load(tx,hash);if(input.nonce!==record.nonce||record.intent==='end-session')fail('invalid_request');await this.gate(tx,hash,record,input,false);return record;});
  const owner=ownerOf(context);if(!owner)fail('unauthorized','Sign in to continue.');
  const identity=await this.authority.entryIdentity(context,owner);if(identity?.subject!==`${this.issuer}/entities/${owner}`)fail('unauthorized','Sign in to continue.');
  if(record.subjectConstraint&&record.subjectConstraint!==identity.subject)fail('account_mismatch','Sign in to the account this application asked about.');
  // Checked again in the owner shard; failing here records no owner, so a fresh sign-in can continue.
  if(record.intent==='reauthenticate'&&(!Number.isSafeInteger(identity.authTime)||identity.authTime<this.clock()-record.maxAge*1000))fail('reauthentication_required','Sign in again to confirm this account.');
  const session=await digest(this.crypto,`entry-session\0${context.sessionContext??context.sessionToken}`);
  // Durable before any approval: one owner per entry, one owner-request ID, resumed on retry.
  const requestId=await this.store.transaction(async tx=>{const current=await this.load(tx,hash);await this.gate(tx,hash,current,input);if(current.selection){if(current.selection.owner!==owner)fail('account_already_chosen','This sign-in already chose another account. Start again from the application.');return current.selection.requestId;}current.selection={owner,session,requestId:`${owner}.${random(this.crypto)}`,selectedAt:this.clock()};await tx.set(`entry/${hash}`,current);return current.selection.requestId;});
  await this.authority.beginEntryAuthorization(context,{requestId,entry:{entryHash:hash,clientId:record.clientId,redirectUri:record.redirectUri,challenge:record.challenge,state:record.state,requests:record.requests,...record.digests?{digests:record.digests}:{},intent:record.intent,delivery:record.delivery,...record.subjectConstraint?{subjectConstraint:record.subjectConstraint}:{},...record.maxAge!==undefined?{maxAge:record.maxAge}:{},...record.dpopJkt?{dpopJkt:record.dpopJkt}:{},...record.embedJkt?{embedJkt:record.embedJkt}:{}}});
  return {requestId};
 }
 async decide(entryId,context,input){
  exact(input,['nonce','pageSecret','plain','approved','denied']);if(input.denied!==undefined&&input.denied!==true||(input.denied===true)===(input.approved!==undefined))fail('invalid_args');const hash=await this.hash(entryId);
  // Cancel from the chooser needs no owner and reveals nothing: one generic access_denied.
  const record=await this.store.transaction(async tx=>{const record=await this.load(tx,hash),cancel=input.denied===true&&!record.selection;if(input.nonce!==record.nonce||!cancel&&(!record.selection||record.selection.owner!==ownerOf(context)))fail('invalid_request','Choose an account first.');await this.gate(tx,hash,record,input);if(cancel){record.completed=true;await tx.set(`entry/${hash}`,record);}return record;});
  const attested=!!record.attested,denial=()=>{const url=new URL(record.redirectUri);for(const [k,v]of Object.entries({error:'access_denied',state:record.state,iss:this.issuer}))url.searchParams.set(k,v);return attested?{error:'access_denied',state:record.state,iss:this.issuer}:{redirectUri:url.href};};
  if(!record.selection)return denial();
  // Denial is the entry's own generic outcome; the owner request is closed best effort.
  if(input.denied){try{await this.authority.approve(context,{requestId:record.selection.requestId,denied:true},{entry:true});}catch{}await this.store.transaction(async tx=>{const current=await tx.get(`entry/${hash}`);if(current){current.completed=true;await tx.set(`entry/${hash}`,current);}});return denial();}
  const result=await this.authority.approve(context,{requestId:record.selection.requestId,approved:input.approved},{entry:true,claim:attested});
  await this.store.transaction(async tx=>{const current=await tx.get(`entry/${hash}`);if(current){current.completed=true;await tx.set(`entry/${hash}`,current);}});
  if(!attested){const {claim,...plainResult}=result;return plainResult;}
  // Attested popup: values go to the popup document only, never to a client redirect.
  const url=new URL(result.redirectUri),state=url.searchParams.get('state'),iss=url.searchParams.get('iss');
  return url.searchParams.has('code')?{code:url.searchParams.get('code'),state,iss,claim:result.claim}:{error:'access_denied',state,iss};
 }
 /** End-session confirmation: `completed` whether or not a session existed. */
 async finishSession(entryId,context,input){
  exact(input,['nonce','confirmed']);if(typeof input.confirmed!=='boolean'||typeof this.endSession!=='function')fail('invalid_request');const hash=await this.hash(entryId);
  const record=await this.store.transaction(tx=>this.load(tx,hash));if(record.intent!=='end-session'||input.nonce!==record.nonce)fail('invalid_request');
  if(input.confirmed)await this.endSession(context,record.subjectConstraint);
  await this.store.transaction(async tx=>{const current=await this.load(tx,hash);current.completed=true;await tx.set(`entry/${hash}`,current);});
  const url=new URL(record.redirectUri);for(const [k,v]of Object.entries({result:input.confirmed?'completed':'canceled',state:record.state,iss:this.issuer}))url.searchParams.set(k,v);return {redirectUri:url.href};
 }
 async cleanup({limit=128}={}){
  return this.store.transaction(async tx=>{let removed=0,remaining=false,pending=false;const now=this.clock();for(const prefix of ['entry/','budget/'])for(const row of await tx.list(prefix)){if(row.value.expiresAt<=now&&removed<limit){await tx.delete(row.key);removed++;}else if(row.value.expiresAt<=now)remaining=true;else pending=true;}return {removed,remaining,pending};});
 }
}

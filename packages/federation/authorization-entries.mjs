// Provider-owned authorization entry (embeddable-elements D1/S4, adaptive-app-sign-in §7.1–7.4). A cookieless,
// pre-owner record pins client, exact callback, PKCE S256, state, scopes, intent, a server nonce and expiry before
// any account is chosen. Owner selection durably records owner, session and the new owner-request ID before the
// owner shard can issue a redeemable approval; retries resume that same request. Entries are stored by hash only.
// Pre-consent privacy (authorization-entry hardening S1): until consent completes, nothing a client can observe
// depends on whether, or as whom, an account was chosen. Owner steps authenticate the caller's live session before
// they read entry state and then see only that caller's own selection; cancel never consults an owner at all.
// Every mutation also carries the per-entry page token, which only a reader of the provider view holds.
// Storage is sharded by entry ID (review M5): an entry and its selections live on the shard named by the ID's first
// character, so every retry reaches the same records; creation budgets live on the caller's own shard.
import {digest,base64url,boundedString,canonical} from '../messaging/store.mjs';
import {fail,object,exact,https} from './schema.mjs';
import {verifyProof,EMBED_PROOF_TYP,jktPattern} from './dpop.mjs';
import {componentsDeclaration,COMPONENTS_PROFILE} from './components-profile.mjs';
import {metadataClientHost,validClientSnapshot,clientSite} from './client-metadata.mjs';
import {UUID_V4 as UUID} from '../core/primitives.mjs';
import {INCREMENTAL_INTENTS,incrementalMembers} from './incremental.mjs';
export const ENTRY_INTENTS=['login','select-account','reauthenticate','end-session'];
export const ENTRY_LIMITS={ttl:600000,challenge:60000,window:600000,perClient:30,perRemote:60,perClientHost:300,global:20000,challenges:3};
export const ENTRY_SHARDS=64;
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const entryKeys=['clientId','redirectUri','challenge','challengeMethod','state','intent','loginHint','subjectConstraint','maxAge','requests','uiLocales','colorScheme','presentation','dpopJkt','embedJkt','delivery','reason','target','suggestion'];
const ID=/^[A-Za-z0-9_-]{43}$/;
const generic=()=>fail('invalid_request','The authorization entry could not be created.');
const expired=()=>fail('invalid_request','This sign-in expired. Start again from the application.');
const unauthorized=()=>fail('unauthorized','Sign in to continue.');
// Owner-shard refusals raised before any code exists (service.approve validation); anything else keeps the decision hold.
const RELEASING=['stale_consent','consent_stale','consent_required','invalid_grant','invalid_preferences','invalid_args','reauthentication_required','account_mismatch','csrf','unauthorized','account_context_conflict','session_context_conflict'];
const random=(crypto,size=32)=>base64url(crypto.getRandomValues(new Uint8Array(size)));
/** Shard ('00'–'63') of a 43-character base64url value: its first character. Entry IDs and remote keys use it. */
export function entryShard(value){if(typeof value!=='string'||!ID.test(value))expired();return String(ALPHABET.indexOf(value[0])).padStart(2,'0');}
/** Shard holding a caller's creation budgets. */
export async function remoteShard(crypto,remote){return entryShard(await digest(crypto,`entry-remote\0${remote}`));}
/** Reauthentication freshness (multi-account-sessions "App-requested account flows"): a credential verified inside
 * this entry's flow (at or after its creation) is always fresh, so `maxAge: 0` succeeds after a fresh sign-in or
 * step-up; an older verification counts only within `maxAge` seconds. `authAfter` is the entry's creation time. */
export const reauthenticationFresh=(authTime,{maxAge,authAfter},now)=>Number.isSafeInteger(authTime)&&Number.isSafeInteger(maxAge)&&Number.isSafeInteger(authAfter)&&authTime<=now+60000&&(authTime>=authAfter||authTime>=now-maxAge*1000);
/** Core `authorization-entry.v1` feature (protocol §2), advertised only where the entry routes are mounted. */
export function entryManifest(issuer,{intents=ENTRY_INTENTS.slice(0,3)}={}){return {features:{'authorization-entry.v1':{endpoint:`${issuer}/api/oauth/entries`,intents:[...intents]}}};}
/** Candidate owner of an owner step. A routing hint only: `entryIdentity` must authenticate it before any use. */
export const ownerOf=context=>{const owner=context?.expectedOwner??(typeof context?.sessionToken==='string'?context.sessionToken.split('.')[0]:'');return UUID.test(owner)?owner:null;};
export class AuthorizationEntries {
 /** `store` is one transactional store, or `shard=>store` for a sharded deployment. A host that serves a single
  * shard (a Worker Durable Object) passes its `shard`, so minted IDs land there and foreign IDs are refused.
  * `endSession` says the adapter mounts a provider session-ending hook at the end-session route. */
 constructor({store,shard,issuer,clients=[],authority,embedOrigin,crypto=globalThis.crypto,clock=()=>Date.now(),dpop=false,pinSchema,endSession=false,limits={},directory,clientMetadata=false,incremental}){
  if(!(typeof store==='function'||store?.transaction)||!authority)throw new TypeError('Entry storage and the federation authority are required.');
  if(shard!==undefined&&(typeof shard!=='string'||!/^\d{2}$/.test(shard)||Number(shard)>=ENTRY_SHARDS||typeof store==='function'))throw new TypeError('A single-shard host needs one store and a shard between 00 and 63.');
  if(embedOrigin!==undefined&&(new URL(embedOrigin).origin!==embedOrigin||embedOrigin===issuer))throw new TypeError('The embed origin must be a dedicated origin.');
  Object.assign(this,{store,shard,issuer,authority,embedOrigin,crypto,clock,dpop:dpop===true,pinSchema,endSession:endSession===true,limits:{...ENTRY_LIMITS,...limits}});
  this.clients=new Map(clients.map(client=>[client.id,client]));
  // Metadata-document clients (client-id-metadata.v1): `directory` resolves them where this instance faces callers;
  // a sharded host behind a resolving facade sets `clientMetadata` and accepts the facade's validated snapshot.
  this.directory=directory;this.clientMetadata=clientMetadata===true||directory?.enabled===true;
  // IA-1: the owner-shard half of `grant-more`/`configure` (runtime/incremental-authorization.mjs). Only a port the
  // adapter mounted with INCREMENTAL_AUTH_ENABLED on reports `mounted`; otherwise the intents are neither accepted nor
  // listed, so the existing declaration row cannot advertise them.
  this.incremental=incremental?.mounted===true?incremental:null;
 }
 /** An unreviewed URL client ID this provider resolves from its metadata document. */
 metadataClient(clientId){return this.clientMetadata&&!this.clients.has(clientId)&&metadataClientHost(clientId)!==null;}
 /** Per-client-host creation budget for metadata clients, on the shard named by the host, so one client host cannot
  * flood the entry store from many addresses. A sharded facade calls it on that shard. */
 async admitHost({clientId}={}){const host=metadataClientHost(clientId);if(!host||!this.metadataClient(clientId))generic();const hostKey=await digest(this.crypto,`entry-client-host\0${clientSite(host)}`);await this.storeFor(entryShard(hostKey)).transaction(tx=>this.budget(tx,`host/${hostKey}`,this.limits.perClientHost));}
 intents(){return [...ENTRY_INTENTS.filter(intent=>intent!=='end-session'||this.endSession),...this.incremental?INCREMENTAL_INTENTS:[]];}
 /** Manifest members for mounted entry routes. The components profile also needs DPoP (embed proofs) and an adapter
  * that actually serves the embed origin, which only the root adapter knows (`components`). */
 manifest({components=false}={}){const entry=entryManifest(this.issuer,{intents:this.intents()});return components&&this.embedOrigin&&this.dpop?{...entry,...componentsDeclaration({profile:COMPONENTS_PROFILE,embedOrigin:this.embedOrigin},{incremental:!!this.incremental})}:entry;}
 sharded(){return typeof this.store==='function'||this.shard!==undefined;}
 storeFor(shard){if(this.shard!==undefined&&shard!==this.shard)fail('temporarily_unavailable','Application sign-in is not available.');return typeof this.store==='function'?this.store(shard):this.store;}
 /** The entry's hash and the store of its shard. */
 async locate(entryId){const shard=entryShard(entryId);if(this.shard!==undefined&&shard!==this.shard)expired();return {hash:await digest(this.crypto,`authorization-entry\0${entryId}`),store:this.storeFor(shard)};}
 async budget(tx,scope,limit){const window=Math.floor(this.clock()/this.limits.window),name=`budget/${scope}/${window}`,record=await tx.get(name)??{count:0,expiresAt:(window+2)*this.limits.window};if(record.count>=limit)fail('rate_limited','Too many sign-in attempts. Try again shortly.');record.count++;await tx.set(name,record);}
 validRequests(requests,intent){
  if(!Array.isArray(requests)||requests.length>8||intent==='end-session'&&requests.length||new TextEncoder().encode(canonical(requests)).length>16384)generic();const seen=new Set();
  for(const request of requests){if(!object(request)||Object.keys(request).some(k=>!['fragment','required','purpose','fields','methods'].includes(k))||typeof request.required!=='boolean'||!boundedString(request.purpose,1000)||!Array.isArray(request.fields)||!request.fields.length||request.fields.length>32||request.fields.some(f=>!boundedString(f,200))||new Set(request.fields).size!==request.fields.length||request.methods!==undefined&&!object(request.methods)||seen.has(request.fragment))generic();try{https(request.fragment);}catch{generic();}seen.add(request.fragment);}
  return structuredClone(requests);
 }
 /** Per-caller and per-client-from-that-caller creation budgets, on the caller's own shard. Adapters must supply a
  * (pseudonymous) remote address. A sharded facade calls this on that shard before `create` on the entry's shard. */
 async admit({clientId,remote}={}){
  if(typeof remote!=='string'||!remote)fail('temporarily_unavailable','Application sign-in is not available.');if(!this.clients.has(clientId)&&!this.metadataClient(clientId))generic();
  const remoteKey=await digest(this.crypto,`entry-remote\0${remote}`),clientKey=await digest(this.crypto,`entry-client\0${clientId}\0${remote}`);
  await this.storeFor(entryShard(remoteKey)).transaction(async tx=>{await this.budget(tx,`remote/${remoteKey}`,this.limits.perRemote);await this.budget(tx,`client/${clientKey}`,this.limits.perClient);});
  if(this.shard===undefined&&this.metadataClient(clientId))await this.admitHost({clientId});
 }
 /** Cookieless creation. `origin` is the browser-set Origin; only the embed origin may create embed entries.
  * `admitted` means a sharded facade already charged the caller's budgets with `admit`; `client` is that facade's
  * validated metadata snapshot (never caller input). Budgets are charged before any metadata fetch. */
 async create(input,{origin,remote,admitted=false,client:resolved}={}){
  if(!object(input)||Object.keys(input).some(k=>!entryKeys.includes(k)))generic();
  let client=this.clients.get(input.clientId);const embed=input.delivery!==undefined;
  if(!client&&this.metadataClient(input.clientId)){
   if(resolved!==undefined){if(resolved?.id!==input.clientId||!validClientSnapshot(resolved))generic();client=structuredClone(resolved);}
   else{if(!this.directory)generic();if(typeof remote!=='string'||!remote)fail('temporarily_unavailable','Application sign-in is not available.');if(!admitted){await this.admit({clientId:input.clientId,remote});admitted=true;}
    try{client=await this.directory.resolve(input.clientId);}catch(error){if(error?.code==='rate_limited')throw error;generic();}}
   // Unreviewed clients have no island shell, so they cannot use the embedded delivery.
   if(embed)generic();
  }
  const incremental=INCREMENTAL_INTENTS.includes(input.intent),configure=input.intent==='configure';
  // `configure` yields no code, so it carries no PKCE challenge and no DPoP key (incremental-authorization §3, §6.2).
  if(!client?.redirectUris?.includes(input.redirectUri)||(configure?input.challengeMethod!==undefined||input.challenge!==undefined||input.dpopJkt!==undefined:input.challengeMethod!=='S256'||typeof input.challenge!=='string'||!ID.test(input.challenge))||typeof input.state!=='string'||!/^[A-Za-z0-9._~-]{16,512}$/.test(input.state)||!this.intents().includes(input.intent)||!['redirect','popup'].includes(input.presentation))generic();
  if(embed?input.delivery!=='embed-popup'||!this.embedOrigin||origin!==this.embedOrigin||input.presentation!=='popup'||input.intent==='end-session'||!jktPattern.test(input.embedJkt??''):input.embedJkt!==undefined||origin!==undefined&&origin!==client.origin)generic();
  // Incremental entries constrain the subject and never take a login hint; their members are refused on other intents.
  if(incremental?input.loginHint!==undefined:input.reason!==undefined||input.target!==undefined||input.suggestion!==undefined)generic();
  const constrained=['reauthenticate','end-session',...INCREMENTAL_INTENTS].includes(input.intent);
  if(constrained!==(input.subjectConstraint!==undefined)||constrained&&(typeof input.subjectConstraint!=='string'||!input.subjectConstraint.startsWith(`${this.issuer}/entities/`)||!UUID.test(input.subjectConstraint.slice(this.issuer.length+10))))generic();
  if((input.intent==='reauthenticate')!==(input.maxAge!==undefined)||input.maxAge!==undefined&&(!Number.isSafeInteger(input.maxAge)||input.maxAge<0||input.maxAge>86400))generic();
  if(input.dpopJkt!==undefined&&(!this.dpop||input.intent==='end-session'||!jktPattern.test(input.dpopJkt)))generic();
  if(input.loginHint!==undefined&&!boundedString(input.loginHint,320)||input.colorScheme!==undefined&&!['light','dark'].includes(input.colorScheme)||input.uiLocales!==undefined&&(!Array.isArray(input.uiLocales)||input.uiLocales.length>4||input.uiLocales.some(tag=>typeof tag!=='string'||tag.length>35||!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(tag))))generic();
  const members=incremental?incrementalMembers(input):null,requests=incremental?members.requests??[]:this.validRequests(input.requests,input.intent);let digests;
  if(this.pinSchema&&requests.length){try{digests=await Promise.all(requests.map(async r=>(await this.pinSchema(r.fragment)).digest));}catch{generic();}}
  // A hint naming another host is ignored, never resolved at creation.
  const hint=input.loginHint?.split('@'),loginHint=hint?.length===2&&hint[1].toLowerCase()===new URL(this.issuer).host?input.loginHint:undefined;
  // A single-shard host mints IDs on its own shard; 250 random bits remain.
  let entryId=random(this.crypto);if(this.shard!==undefined)entryId=ALPHABET[Number(this.shard)]+entryId.slice(1);
  const now=this.clock(),record={v:2,clientId:input.clientId,redirectUri:input.redirectUri,...input.challenge!==undefined?{challenge:input.challenge}:{},state:input.state,intent:input.intent,requests,...members?.target?{target:members.target}:{},...members?.suggestion?{suggestion:members.suggestion}:{},...members?.reason!==undefined?{reason:members.reason}:{},...digests?{digests}:{},presentation:input.presentation,delivery:embed?'embed-popup':input.presentation,...loginHint?{loginHint}:{},...constrained?{subjectConstraint:input.subjectConstraint}:{},...input.maxAge!==undefined?{maxAge:input.maxAge}:{},...input.uiLocales?.length?{uiLocales:[...input.uiLocales]}:{},...input.colorScheme?{colorScheme:input.colorScheme}:{},...input.dpopJkt?{dpopJkt:input.dpopJkt}:{},...embed?{embedJkt:input.embedJkt}:{},...client.reviewed===false?{client}:{},nonce:random(this.crypto,16),page:random(this.crypto),createdAt:now,expiresAt:now+this.limits.ttl};
  // Unauthenticated creation is budgeted per caller address, per client from that address and globally, so one
  // caller cannot drain another client's budget. Each shard holds its share of the global budget.
  if(typeof remote!=='string'||!remote)fail('temporarily_unavailable','Application sign-in is not available.');
  if(!admitted)await this.admit({clientId:input.clientId,remote});
  const {hash,store}=await this.locate(entryId),global=this.sharded()?Math.ceil(this.limits.global/ENTRY_SHARDS):this.limits.global;
  if(incremental){
   // Owner-state checks (connection, grant coverage, suggestion schema, tier 4), caps and the decline ladder. The
   // answer is `{entryId}` whether or not anything is suppressed; only `rate_limited` carries Retry-After (§9.3, §10).
   await store.transaction(tx=>this.budget(tx,'global',global));
   try{await this.incremental.admit({entryHash:hash,subject:input.subjectConstraint,clientId:input.clientId,client:{id:client.id,name:client.name,origin:client.origin,reviewed:client.reviewed!==false},intent:input.intent,...members,binding:{redirectUri:input.redirectUri,...input.challenge?{challenge:input.challenge}:{},...input.dpopJkt?{dpopJkt:input.dpopJkt}:{}}});}
   catch(error){if(['rate_limited','temporarily_unavailable'].includes(error?.code))throw error;generic();}
   await store.transaction(tx=>tx.set(`entry/${hash}`,record));return {entryId};
  }
  await store.transaction(async tx=>{await this.budget(tx,'global',global);await tx.set(`entry/${hash}`,record);});
  return {entryId};
 }
 async load(tx,hash){const record=await tx.get(`entry/${hash}`);if(!record||record.v!==2||record.expiresAt<=this.clock()||record.completed)expired();return record;}
 /** The per-entry page token: derived from the entry ID (never stored) and a stored salt, returned only by the view. */
 pageToken(entryId,record){return digest(this.crypto,`authorization-entry-page\0${entryId}\0${record.page}`);}
 async checkPage(entryId,record,page){const token=page?.token;if(typeof token!=='string'||!ID.test(token)||await digest(this.crypto,`page\0${token}`)!==await digest(this.crypto,`page\0${await this.pageToken(entryId,record)}`))fail('csrf','Reload the provider page before continuing.');}
 /** Session-independent request metadata for the static provider page, and its page token. */
 async view(entryId){
  const {hash,store}=await this.locate(entryId),record=await store.transaction(tx=>this.load(tx,hash)),client=this.clients.get(record.clientId)??(this.clientMetadata&&record.client?.id===record.clientId&&validClientSnapshot(record.client)?record.client:null);if(!client)expired();
  // An unreviewed client is labelled by its verified origin; its self-declared name is marked as unverified.
  return {entry:{client:{id:client.id,name:client.name,origin:client.origin,...client.reviewed===false?{reviewed:false,...client.claimedName?{claimedName:client.claimedName}:{}}:{}},redirectUri:record.redirectUri,intent:record.intent,requests:structuredClone(record.requests),presentation:record.presentation,delivery:record.delivery,nonce:record.nonce,expiresAt:record.expiresAt,...record.loginHint?{loginHint:record.loginHint}:{},...record.subjectConstraint?{subjectConstraint:record.subjectConstraint}:{},...record.maxAge!==undefined?{maxAge:record.maxAge}:{},...record.reason!==undefined?{reason:record.reason}:{},...record.target?{target:structuredClone(record.target)}:{},...record.suggestion?{suggestion:structuredClone(record.suggestion)}:{},...record.uiLocales?{uiLocales:record.uiLocales}:{},...record.colorScheme?{colorScheme:record.colorScheme}:{},...record.delivery==='embed-popup'?{embed:{attested:!!record.attested,plain:!!record.plain,...this.embedOrigin?{origin:this.embedOrigin}:{}}}:{}},pageToken:await this.pageToken(entryId,record)};
 }
 /** COOP class of the static entry document (§9). Unknown entries get the strict page. */
 async documentPolicy(entryId,mode){if(mode!==undefined&&mode!=='plain')return 'same-origin';let record=null;try{const {hash,store}=await this.locate(entryId);record=await store.transaction(tx=>tx.get(`entry/${hash}`));}catch{}return record&&record.expiresAt>this.clock()&&record.delivery==='embed-popup'&&!record.plain&&mode!=='plain'?'unsafe-none':'same-origin';}
 async challenge(entryId,page){
  const {hash,store}=await this.locate(entryId);
  return store.transaction(async tx=>{const record=await this.load(tx,hash);await this.checkPage(entryId,record,page);if(record.delivery!=='embed-popup'||record.plain||record.attested||(record.challenges??0)>=this.limits.challenges)fail('embed_attestation_failed','This window cannot continue in the embedded sign-in.');const challenge=random(this.crypto,16);Object.assign(record,{challenges:(record.challenges??0)+1,challengeHash:await digest(this.crypto,`embed-challenge\0${challenge}`),challengeExpiresAt:Math.min(this.clock()+this.limits.challenge,record.expiresAt)});await tx.set(`entry/${hash}`,record);return {challenge};});
 }
 /** Opener-key handshake (§7.3): proof of the entry's embedJkt over a single-use challenge. */
 async verify(entryId,input,page){
  exact(input,['proof']);const {hash,store}=await this.locate(entryId),record=await store.transaction(tx=>this.load(tx,hash)),refuse=()=>fail('embed_attestation_failed','This window cannot continue in the embedded sign-in.');
  await this.checkPage(entryId,record,page);if(record.delivery!=='embed-popup'||record.plain||record.attested||!record.challengeHash)refuse();
  let proof;try{proof=await verifyProof(this.crypto,input.proof,{typ:EMBED_PROOF_TYP,htm:'POST',htu:`${this.issuer}/oauth/entries/${entryId}/embed-verify`,now:this.clock(),claims:{entry:entryId},nonce:async value=>{if(typeof value!=='string'||await digest(this.crypto,`embed-challenge\0${value}`)!==record.challengeHash||record.challengeExpiresAt<=this.clock())fail('invalid');return {hash:record.challengeHash,expiresAt:record.challengeExpiresAt};}});}catch{refuse();}
  if(proof.jkt!==record.embedJkt)refuse();
  const pageSecret=random(this.crypto),pageHash=await digest(this.crypto,`embed-page\0${pageSecret}`);
  await store.transaction(async tx=>{const current=await this.load(tx,hash);if(current.plain||current.attested||current.challengeHash!==record.challengeHash||current.challengeExpiresAt<=this.clock())refuse();delete current.challengeHash;delete current.challengeExpiresAt;current.attested={pageHash,at:this.clock()};await tx.set(`entry/${hash}`,current);});
  return {pageSecret};
 }
 /** Embed entries need the attested page's secret, or the plain page's earlier irreversible declaration. Owner
  * steps never change embed state, so the view and document policy cannot reveal a selection (review finding 1). */
 async gate(tx,hash,record,{pageSecret,plain}){
  if(record.delivery!=='embed-popup'){if(pageSecret!==undefined||plain!==undefined&&plain!==true)fail('invalid_request');return;}
  if(record.attested){if(typeof pageSecret!=='string'||await digest(this.crypto,`embed-page\0${pageSecret}`)!==record.attested.pageHash)fail('embed_attestation_required','Reopen sign-in from the application.');return;}
  if(pageSecret!==undefined||plain!==true||!record.plain)fail('embed_attestation_required','Reopen sign-in from the application.');
 }
 /** The plain page (§7.3 step 6) declares plain mode when it loads, before any account UI, so the flag never tracks
  * the user's choice. Anyone holding the page token can make this irreversible downgrade: the entry then completes
  * only through the COOP-isolated page and the registered callback, and no claim is ever minted. */
 async declarePlain(entryId,page){
  const {hash,store}=await this.locate(entryId);
  return store.transaction(async tx=>{const record=await this.load(tx,hash);await this.checkPage(entryId,record,page);if(record.delivery!=='embed-popup'||record.attested)fail('embed_attestation_failed','This window cannot continue in the embedded sign-in.');if(!record.plain){record.plain=true;delete record.challengeHash;delete record.challengeExpiresAt;await tx.set(`entry/${hash}`,record);}return {plain:true};});
 }
 /** Authenticates the owner step's caller (live session and, for mutations, its CSRF) before any entry state is read. */
 async caller(context){const owner=ownerOf(context);if(!owner)unauthorized();const identity=await this.authority.entryIdentity(context,owner);if(identity?.subject!==`${this.issuer}/entities/${owner}`)unauthorized();return {owner,identity};}
 /** Opens the page-authenticated entry for an owner step or cancel; the nonce is public and only matched. */
 async opened(tx,entryId,hash,page,nonce){const record=await this.load(tx,hash);await this.checkPage(entryId,record,page);if(nonce!==record.nonce)fail('invalid_request');return record;}
 /** Owner choice. Each owner has its own durable selection (one owner request, resumed on retry), so a caller learns
  * nothing about another owner's choice. Only one owner can complete the entry (`decide`). */
 async select(entryId,context,input,page){
  exact(input,['nonce','plain','pageSecret']);const {owner,identity}=await this.caller(context),{hash,store}=await this.locate(entryId);
  const record=await store.transaction(async tx=>{const record=await this.opened(tx,entryId,hash,page,input.nonce);if(record.intent==='end-session')fail('invalid_request');await this.gate(tx,hash,record,input);return record;});
  if(record.subjectConstraint&&record.subjectConstraint!==identity.subject)fail('account_mismatch','Sign in to the account this application asked about.');
  // Checked again in the owner shard; failing here records nothing, so a fresh sign-in can continue.
  if(record.intent==='reauthenticate'&&!reauthenticationFresh(identity.authTime,{maxAge:record.maxAge,authAfter:record.createdAt},this.clock()))fail('reauthentication_required','Sign in again to confirm this account.');
  const session=await digest(this.crypto,`entry-session\0${context.sessionContext??context.sessionToken}`);
  // Durable before any approval: one owner-request ID per owner and entry, resumed on retry.
  const requestId=await store.transaction(async tx=>{const current=await this.load(tx,hash);await this.gate(tx,hash,current,input);const key=`selection/${hash}/${owner}`,existing=await tx.get(key);if(existing)return existing.requestId;const selection={owner,session,requestId:`${owner}.${random(this.crypto)}`,selectedAt:this.clock(),expiresAt:current.expiresAt};await tx.set(key,selection);return selection.requestId;});
  // Incremental intents: the owner-shard view (delta, setup, pre-declined items) or an immediate no-delta completion.
  if(INCREMENTAL_INTENTS.includes(record.intent)){
   if(!this.incremental)expired();const begun=await this.incremental.begin({entryHash:hash,subject:identity.subject});
   if(begun.complete){await this.complete(store,hash);return {requestId,completed:this.incrementalRedirect(record,begun.complete)};}
   return {requestId,incremental:begun.view};
  }
  // IA-R2 (incremental-authorization §9.1): on an existing connection the delta of any intent is a grant-more for
  // caps, the ladder, suppression and tier 4; blocked items are narrowed to held access (a plain decline to the app)
  // and every request becomes optional. A first connection is unchanged.
  let requests=record.requests,digests=record.digests,login=null;
  if(this.incremental&&requests.length){if(typeof this.incremental.loginDelta!=='function')fail('temporarily_unavailable','Application sign-in is not available.');const client=this.clients.get(record.clientId)??record.client;login=await this.incremental.loginDelta({entryHash:hash,subject:identity.subject,clientId:record.clientId,client:{id:client.id,name:client.name,origin:client.origin,reviewed:client.reviewed!==false},requests:structuredClone(requests)});if(!login.first){requests=login.requests;digests=record.digests?login.keep.map(n=>record.digests[n]):undefined;}}
  const begun=await this.authority.beginEntryAuthorization(context,{requestId,entry:{entryHash:hash,clientId:record.clientId,redirectUri:record.redirectUri,challenge:record.challenge,state:record.state,requests,...digests?{digests}:{},intent:record.intent,delivery:record.delivery,...record.subjectConstraint?{subjectConstraint:record.subjectConstraint}:{},...record.maxAge!==undefined?{maxAge:record.maxAge,authAfter:record.createdAt}:{},...record.dpopJkt?{dpopJkt:record.dpopJkt}:{},...record.embedJkt?{embedJkt:record.embedJkt}:{}}},record.client&&!this.clients.has(record.clientId)?{client:record.client}:undefined);
  // Provider-page-only: access this owner already granted this client, ready to resubmit with one click.
  return {requestId,...Array.isArray(begun?.approved)?{approved:begun.approved}:{},...login&&!login.first?{incrementalLogin:{additions:login.additions,predeclined:login.predeclined}}:{}};
 }
 denial(record){const params={error:'access_denied',state:record.state,iss:this.issuer};if(record.attested)return params;const url=new URL(record.redirectUri);for(const [k,v]of Object.entries(params))url.searchParams.set(k,v);return {redirectUri:url.href};}
 /** Cancel needs no owner and consults none: one store transaction and one generic access_denied, whatever was chosen. */
 async cancel(entryId,input,page){
  const {hash,store}=await this.locate(entryId);
  const record=await store.transaction(async tx=>{const record=await this.opened(tx,entryId,hash,page,input.nonce);if(record.intent==='end-session')fail('invalid_request');await this.gate(tx,hash,record,input);if(INCREMENTAL_INTENTS.includes(record.intent))return record;record.completed=true;await tx.set(`entry/${hash}`,record);return record;});
  if(!INCREMENTAL_INTENTS.includes(record.intent)){if(this.incremental?.loginOutcome)try{await this.incremental.loginOutcome({entryHash:hash,approved:null});}catch{}return this.denial(record);}
  // Incremental cancel without a decision: declined / unchanged through the normal code or result, caps only (§10).
  if(!this.incremental)expired();const completion=await this.incremental.abandon({entryHash:hash});await this.complete(store,hash);return this.incrementalRedirect(record,completion);
 }
 async complete(store,hash){await store.transaction(async tx=>{const current=await tx.get(`entry/${hash}`);if(current&&!current.completed){current.completed=true;await tx.set(`entry/${hash}`,current);}});}
 /** `grant-more` returns a code (outcomes ride the token response); `configure` returns exactly result, state, iss. */
 incrementalRedirect(record,completion){const result={...typeof completion?.code==='string'?{code:completion.code}:{result:completion.result},state:record.state,iss:this.issuer};if(record.attested)return result;const url=new URL(record.redirectUri);for(const [k,v] of Object.entries(result))url.searchParams.set(k,v);return {redirectUri:url.href};}
 /** Owner decision on an incremental entry. Decline and the blocked notice's return need the owner too: they advance
  * the ladder and may record a suppression. A retry after completion returns the stored answer (CX §6.7). */
 async decideIncremental(entryId,context,input,page){
  exact(input,['nonce','pageSecret','plain','approved','denied','notice','suppress','reveal','changes','sharedAcknowledged','setup']);if(!this.incremental)expired();
  const {owner,identity}=await this.caller(context),{hash,store}=await this.locate(entryId);
  const record=await store.transaction(async tx=>{const raw=await tx.get(`entry/${hash}`);if(raw?.completed&&raw.v===2&&raw.expiresAt>this.clock()&&INCREMENTAL_INTENTS.includes(raw.intent)){await this.checkPage(entryId,raw,page);if(input.nonce!==raw.nonce)fail('invalid_request');}else await this.opened(tx,entryId,hash,page,input.nonce);const record=raw;if(!await tx.get(`selection/${hash}/${owner}`))fail('invalid_request','Choose an account first.');await this.gate(tx,hash,record,input);return record;});
  const {nonce,pageSecret,plain,...decision}=input,completion=await this.incremental.decide({entryHash:hash,subject:identity.subject,decision});
  await this.complete(store,hash);return this.incrementalRedirect(record,completion);
 }
 async decide(entryId,context,input,page){
  if(this.incremental){const {hash,store}=await this.locate(entryId),peek=await store.transaction(async tx=>{const raw=await tx.get(`entry/${hash}`);return raw&&INCREMENTAL_INTENTS.includes(raw.intent)?raw:null;});if(peek)return this.decideIncremental(entryId,context,input,page);}
  exact(input,['nonce','pageSecret','plain','approved','denied']);if(input.denied!==undefined&&input.denied!==true||(input.denied===true)===(input.approved!==undefined))fail('invalid_args');
  if(input.denied===true)return this.cancel(entryId,input,page);
  const {owner}=await this.caller(context),{hash,store}=await this.locate(entryId);
  // The caller's own selection only. The first owner to decide holds the entry; a concurrent decision by another
  // owner looks exactly like a completed entry, which the client learns from its callback anyway.
  const {record,selection,attempt}=await store.transaction(async tx=>{const record=await this.opened(tx,entryId,hash,page,input.nonce);if(record.intent==='end-session')fail('invalid_request');const selection=await tx.get(`selection/${hash}/${owner}`);if(!selection)fail('invalid_request','Choose an account first.');await this.gate(tx,hash,record,input);let attempt=null;if(record.deciding&&record.deciding.owner!==owner)expired();if(!record.deciding){attempt=random(this.crypto,16);record.deciding={owner,attempt};await tx.set(`entry/${hash}`,record);}return {record,selection,attempt};});
  const attested=!!record.attested;let result;
  try{result=await this.authority.approve(context,{requestId:selection.requestId,approved:input.approved},{entry:true,claim:attested});}
  catch(error){
   // Only this attempt's own hold, and only after a refusal that proves nothing was issued, lets another account
   // decide. A retry under an existing hold, an unknown outcome or a no-longer-pending request keeps it (review 2, 3).
   if(attempt&&RELEASING.includes(error?.code))await store.transaction(async tx=>{const current=await tx.get(`entry/${hash}`);if(current?.deciding?.attempt===attempt&&!current.completed){delete current.deciding;await tx.set(`entry/${hash}`,current);}});
   throw error;
  }
  // A cancel that committed while this decision was in flight already answered access_denied; the entry has one
  // outcome, so the issued code is never delivered (it stays unredeemed and expires).
  const cancelled=await store.transaction(async tx=>{const current=await tx.get(`entry/${hash}`);if(current?.completed)return true;if(current){current.completed=true;await tx.set(`entry/${hash}`,current);}return false;});
  if(cancelled)expired();
  // IA-R2: the owner's answer to a login delta advances or resets the shared ladder (accounting only; never fails the login).
  if(this.incremental?.loginOutcome)try{await this.incremental.loginOutcome({entryHash:hash,subject:`${this.issuer}/entities/${owner}`,approved:input.approved});}catch{}
  if(!attested){const {claim,...plainResult}=result;return plainResult;}
  // Attested popup: values go to the popup document only, never to a client redirect.
  const url=new URL(result.redirectUri),state=url.searchParams.get('state'),iss=url.searchParams.get('iss');
  return url.searchParams.has('code')?{code:url.searchParams.get('code'),state,iss,claim:result.claim}:{error:'access_denied',state,iss};
 }
 async endEntry(tx,entryId,hash,input,page){exact(input,['nonce','confirmed']);if(typeof input.confirmed!=='boolean'||!this.endSession)fail('invalid_request');const record=await this.opened(tx,entryId,hash,page,input.nonce);if(record.intent!=='end-session')fail('invalid_request');return record;}
 /** End-session, step 1: the confirmed entry's subject, for the adapter's session-ending hook. Changes nothing. */
 async endTarget(entryId,input,page){const {hash,store}=await this.locate(entryId),record=await store.transaction(tx=>this.endEntry(tx,entryId,hash,input,page));return {subject:record.subjectConstraint};}
 /** End-session, step 2 (after the hook ended any session): `completed` whether or not a session existed. */
 async finishSession(entryId,input,page){
  const {hash,store}=await this.locate(entryId),record=await store.transaction(async tx=>{const record=await this.endEntry(tx,entryId,hash,input,page);record.completed=true;await tx.set(`entry/${hash}`,record);return record;});
  const url=new URL(record.redirectUri);for(const [k,v]of Object.entries({result:input.confirmed?'completed':'canceled',state:record.state,iss:this.issuer}))url.searchParams.set(k,v);return {redirectUri:url.href};
 }
 /** Prunes one store: the only store, the host's own shard, or `shard` of a sharded store. */
 async cleanup({limit=128,shard}={}){
  const store=typeof this.store==='function'?(shard!==undefined?this.store(shard):null):this.store;if(!store)throw new TypeError('A sharded entry store is cleaned one shard at a time.');
  return store.transaction(async tx=>{let removed=0,remaining=false,pending=false;const now=this.clock();for(const prefix of ['entry/','selection/','budget/'])for(const row of await tx.list(prefix)){if(row.value.expiresAt<=now&&removed<limit){await tx.delete(row.key);removed++;}else if(row.value.expiresAt<=now)remaining=true;else pending=true;}return {removed,remaining,pending};});
 }
}

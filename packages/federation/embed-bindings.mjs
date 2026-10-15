// Key-bound provider-component (embed) credentials, 3sln embed profile (adaptive-app-sign-in §6.3, §7.4, §12.1).
// A claim is minted only for an attested entry's approval, is redeemable once with a proof from the entry's
// embedJkt, and yields a credential that becomes active only when the paired code is exchanged. None of these
// values is accepted at the token, revocation or RPC endpoints (distinct hash domains).
import {digest} from '../messaging/store.mjs';
import {fail,exact} from './schema.mjs';
import {APP_SESSION} from './app-sessions.mjs';
export const EMBED={claim:120000,pending:600000,session:600000,perClient:8,live:64,perPartition:4,streams:2};
const key=(kind,id)=>`federation/${kind}/${id}`;
const denied=()=>fail('unauthorized','The embedded session is unavailable.');
/** Inside approve(): binds a claim to the issued code. */
export async function mintClaim(service,tx,{codeHash,subject,epoch,clientId,embedJkt}){
 await service.bounded(tx,'claim',64);const claim=service.random(),hash=await digest(service.crypto,`embed-claim\0${claim}`);
 await tx.set(key('claim',hash),{codeHash,subject,epoch,clientId,embedJkt,used:false,expiresAt:service.clock()+EMBED.claim});return {claim,claimHash:hash};
}
async function liveFamily(service,tx,record){
 const family=record.familyId&&await tx.get(key('family',record.familyId)),now=service.clock();
 if(!family||family.status!=='active'||family.expiresAt<=now||(family.idleExpiresAt??Infinity)<=now||family.subject!==record.subject||family.clientId!==record.clientId||family.epoch!==record.epoch)denied();
 return family;
}
/** Inside exchange(): links the paired claim or credential to the new app session. */
export async function linkExchange(service,tx,code,family){
 if(!code.claimHash)return;const claim=await tx.get(key('claim',code.claimHash));if(!claim)return;
 if(!family){await tx.delete(key('claim',code.claimHash));if(claim.credentialHash)await tx.delete(key('embed',claim.credentialHash));return;}
 claim.familyId=family.familyId;claim.expiresAt=Math.max(claim.expiresAt,service.clock()+EMBED.claim);await tx.set(key('claim',code.claimHash),claim);
 const credential=claim.credentialHash&&await tx.get(key('embed',claim.credentialHash));
 if(credential?.status==='pending')await tx.set(key('embed',claim.credentialHash),activate(service,credential,family));
}
const activate=(service,credential,family)=>({...credential,status:'active',familyId:family.familyId,expiresAt:family.expiresAt,idleExpiresAt:Math.min(service.clock()+APP_SESSION.idle,family.expiresAt)});
async function checkLive(service,tx,credential){
 const now=service.clock();if(!credential||credential.status!=='active'||credential.expiresAt<=now||credential.idleExpiresAt<=now||!service.clients.has(credential.clientId))denied();
 const family=await liveFamily(service,tx,credential);
 try{await service.active(credential.subject,credential.epoch);if(service.connections&&(!family.connection||await service.connections.check(family.connection,family.clientId)!==true))denied();await service.liveGrantIds(tx,family);}catch{denied();}
 return family;
}
export async function redeemClaim(service,input){
 exact(input,['claim','dpop']);if(!service.opaque(input.claim))denied();
 const hash=await digest(service.crypto,`embed-claim\0${input.claim}`),proof=await service.embedProof(input.dpop,'claim',input.claim);
 return service.store.transaction(async tx=>{
  const claim=await tx.get(key('claim',hash)),now=service.clock();
  if(!claim||claim.used||claim.expiresAt<=now||!service.clients.has(claim.clientId))denied();
  // A valid proof from another key is rejected like any other failure and changes nothing.
  if(proof.jkt!==claim.embedJkt)denied();
  await service.consumeProof(tx,proof);await service.active(claim.subject,claim.epoch);
  const live=(await tx.list(key('embed',''))).filter(row=>row.value.expiresAt>now);
  // Caps evict the oldest binding rather than refusing (islands design).
  for(const row of [...live].sort((a,b)=>a.value.createdAt-b.value.createdAt).slice(0,Math.max(0,live.length-EMBED.live+1)))await tx.delete(row.key);
  const credential=service.random(),credentialHash=await digest(service.crypto,`embed\0${credential}`);
  let record={subject:claim.subject,epoch:claim.epoch,clientId:claim.clientId,jkt:claim.embedJkt,status:'pending',createdAt:now,expiresAt:now+EMBED.pending,idleExpiresAt:now+EMBED.pending};
  if(claim.familyId)record=activate(service,record,await liveFamily(service,tx,{...record,familyId:claim.familyId}));
  // Per client and owner, the oldest bindings yield beyond eight.
  const siblings=live.filter(row=>row.value.clientId===claim.clientId&&row.value.subject===claim.subject).sort((a,b)=>a.value.createdAt-b.value.createdAt);
  for(const row of siblings.slice(0,Math.max(0,siblings.length-EMBED.perClient+1)))await tx.delete(row.key);
  Object.assign(claim,{used:true,credentialHash});await tx.set(key('claim',hash),claim);await tx.set(key('embed',credentialHash),record);
  return {credential,expires_in:Math.floor((record.expiresAt-now)/1000)};
 });
}
async function credentialRecord(service,input,purpose){
 exact(input,['credential','dpop']);if(!service.opaque(input.credential))denied();
 const hash=await digest(service.crypto,`embed\0${input.credential}`),proof=await service.embedProof(input.dpop,purpose,input.credential);return {hash,proof};
}
/** Starts or renews an embed session with a key proof (adaptive-app-sign-in §6.3). */
export async function startSession(service,input){
 const {hash,proof}=await credentialRecord(service,input,'session');
 const result=await service.store.transaction(async tx=>{
  const credential=await tx.get(key('embed',hash));if(!credential||proof.jkt!==credential.jkt)denied();
  const family=await checkLive(service,tx,credential);await service.consumeProof(tx,proof);const now=service.clock();
  credential.idleExpiresAt=Math.min(now+APP_SESSION.idle,credential.expiresAt);await tx.set(key('embed',hash),credential);
  // One partition (one frame key) holds at most four sessions shared by its islands; the oldest yields.
  const sessions=(await tx.list(key('embed-session',''))).filter(row=>row.value.expiresAt>now),partition=sessions.filter(row=>row.value.jkt===credential.jkt&&row.value.clientId===credential.clientId).sort((a,b)=>a.value.createdAt-b.value.createdAt);
  for(const row of partition.slice(0,Math.max(0,partition.length-EMBED.perPartition+1)))await tx.delete(row.key);
  await service.bounded(tx,'embed-session',128);const session=service.random();
  await tx.set(key('embed-session',await digest(service.crypto,`embed-session\0${session}`)),{credentialHash:hash,familyId:family.familyId,jkt:credential.jkt,clientId:credential.clientId,createdAt:now,expiresAt:Math.min(now+EMBED.session,credential.expiresAt)});
  return {session,subject:credential.subject};
 });
 return {session:result.session,expires_in:EMBED.session/1000,view:await embedView(service,result.subject)};
}
/** Resolves a live embed session from its token and a consumed key proof; returns the credential record. */
async function liveSession(service,tx,hash,proof){
 const session=await tx.get(key('embed-session',hash));if(!session||session.expiresAt<=service.clock()||proof&&proof.jkt!==session.jkt)denied();
 const credential=await tx.get(key('embed',session.credentialHash));if(!credential||credential.jkt!==session.jkt||credential.familyId!==session.familyId)denied();
 await checkLive(service,tx,credential);if(proof)await service.consumeProof(tx,proof);return {session,credential};
}
async function sessionProof(service,input,purpose,htm='POST'){
 exact(input,['session','dpop']);if(!service.opaque(input.session))denied();
 return {hash:await digest(service.crypto,`embed-session\0${input.session}`),proof:await service.embedProof(input.dpop,purpose,input.session,htm)};
}
/** Reads the binding's labels with the session and a fresh key proof. */
export async function sessionState(service,input){
 const {hash,proof}=await sessionProof(service,input,'state');
 const subject=await service.store.transaction(async tx=>(await liveSession(service,tx,hash,proof)).credential.subject);
 return {view:await embedView(service,subject)};
}
/** Avatar source for `GET /embed/api/avatar` (embed islands §6.2): session plus a GET key proof. The URL never leaves
 * the provider; the HTTP layer fetches, re-encodes and serves raster bytes only. */
export async function sessionAvatar(service,input){
 const {hash,proof}=await sessionProof(service,input,'avatar','GET');
 const subject=await service.store.transaction(async tx=>(await liveSession(service,tx,hash,proof)).credential.subject);
 return {avatar:(await profileOf(service,subject)).avatar};
}
/** Opens the leader's data stream (`GET /embed/api/events`): a lease per stream, at most two per credential, and the
 * oldest yields (embed islands §5.3 step 6). */
export async function openStream(service,input){
 const {hash,proof}=await sessionProof(service,input,'events','GET');
 const result=await service.store.transaction(async tx=>{
  const {session,credential}=await liveSession(service,tx,hash,proof),now=service.clock();
  const leases=(await tx.list(key('embed-stream',''))).filter(row=>row.value.expiresAt>now),mine=leases.filter(row=>row.value.credentialHash===session.credentialHash).sort((a,b)=>a.value.createdAt-b.value.createdAt);
  for(const row of mine.slice(0,Math.max(0,mine.length-EMBED.streams+1)))await tx.delete(row.key);
  await service.bounded(tx,'embed-stream',128);const lease=service.random();
  await tx.set(key('embed-stream',await digest(service.crypto,`embed-stream\0${lease}`)),{sessionHash:hash,credentialHash:session.credentialHash,createdAt:now,expiresAt:session.expiresAt});
  return {lease,subject:credential.subject,expiresAt:session.expiresAt};
 });
 return {lease:result.lease,expires_in:Math.max(0,Math.floor((result.expiresAt-service.clock())/1000)),view:await embedView(service,result.subject)};
}
/** One stream heartbeat: the lease, its session and the binding must all still be live. */
export async function streamTick(service,input){
 exact(input,['session','lease']);if(!service.opaque(input.session)||!service.opaque(input.lease))denied();
 const hash=await digest(service.crypto,`embed-session\0${input.session}`),leaseKey=key('embed-stream',await digest(service.crypto,`embed-stream\0${input.lease}`));
 const subject=await service.store.transaction(async tx=>{const lease=await tx.get(leaseKey);if(!lease||lease.sessionHash!==hash||lease.expiresAt<=service.clock())denied();return (await liveSession(service,tx,hash,null)).credential.subject;});
 return {view:await embedView(service,subject)};
}
/** `POST /embed/api/session/end` (embed islands §5.3): bearer only, because it runs from `pagehide` with `keepalive`
 * where a nonce round trip is unreliable. It only ends the session and its streams, and answers identically whether or
 * not anything was ended. */
export async function endSession(service,input){
 exact(input,['session']);if(!service.opaque(input.session))return {};
 const hash=await digest(service.crypto,`embed-session\0${input.session}`);
 await service.store.transaction(async tx=>{await tx.delete(key('embed-session',hash));for(const row of await tx.list(key('embed-stream','')))if(row.value.sessionHash===hash)await tx.delete(row.key);});
 return {};
}
/** "Remove from this site": deletes exactly this credential and its sessions. */
export async function forget(service,input){
 const {hash,proof}=await credentialRecord(service,input,'forget');
 return service.store.transaction(async tx=>{
  const credential=await tx.get(key('embed',hash));if(!credential||proof.jkt!==credential.jkt)denied();
  await service.consumeProof(tx,proof);await tx.delete(key('embed',hash));
  for(const kind of ['embed-session','embed-stream'])for(const row of await tx.list(key(kind,'')))if(row.value.credentialHash===hash)await tx.delete(row.key);return {};
 });
}
async function profileOf(service,subject){
 if(typeof service.embedView!=='function')fail('temporarily_unavailable');const view=await service.embedView(subject);
 return {handle:String(view.handle),name:view.name?String(view.name):undefined,avatar:typeof view.avatar==='string'&&view.avatar?view.avatar:null};
}
/** The island view: the binding's subject (so islands can match the app's `session` subject), labels and avatar presence only. */
async function embedView(service,subject){
 const view=await profileOf(service,subject);
 return {subject,handle:view.handle,...view.name?{name:view.name}:{},avatar:view.avatar!==null};
}

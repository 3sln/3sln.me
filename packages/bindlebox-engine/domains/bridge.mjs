// Bridge receiver (slice BB-B7; docs/spec/bindlebox.md §9; architecture §12.1, §13; public-email-bridge.md): the
// BindleBox side of bridged public intake through the `public-message-intake` slot. The provider's SMTP entry point,
// holding queue, provenance signing, reply gates and its single invariant auto-reply are the provider's (BRIDGE, a
// later slice); this domain receives the provider's `deliver` RPC and never talks back over the channel.
//
// `bridge.receive` (ingress actor; the app shell authenticates the brokered consumer token and passes the consumer
// origin and the addressed resource, never the request body's claims):
//  1. strict RPC framing (parseRPC: I-JSON, exact members, the intake contract and `deliver` only, ≤ 1 MiB parts);
//  2. consumer authorization: the owner's own provider (`iss` = the mailbox principal's issuer) for channel `email`,
//     or an application consumer the owner allowed for exactly its channel. Anything else is not_authorized, before
//     any key lookup;
//  3. provenance (B2's intake.deliver: the consumer's discovered key, `iss`, `recipient`, the normalized digest, the
//     7-day `receivedAt` window). Provenance is the CONSUMER's signature over its own assertions. It is never
//     authorship: the item is channel-origin with an unverified sender, joins no conversation, matches no principal
//     allowlist, and is classified only as a public request;
//  4. dedup: (consumer, tx) and (consumer, jti) in B2, plus (consumer, ingressFingerprint) here, so the same accepted
//     mail re-signed under a new jti or tx after a provider crash is stored once. The same key with other content is
//     operation_conflict, never a stored disposition;
//  5. spam tiers run later in intake.drain (B2), after custody, so nothing in the response depends on them.
// No backscatter: this domain has no egress or reply port. The result is exactly `{disposition}`, owner-visible
// status only, and `stored-receipt` whatever the later tier, rule or allowlist outcome (spec §6.7, §9). A disabled
// bridge answers `refused` without storing anything; the provider's SMTP behaviour and auto-reply MUST NOT vary with
// it (extensions §9.8). Everything is not_found unless BINDLEBOX_ENABLED.
import {INTAKE_CONTRACT,parseRPC,parseProvenance,intakeDigest,ProtocolFault} from '../../bindlebox-protocol/index.mjs';
import {MailboxAction,MailboxQuery} from '../engine.mjs';
import {fault} from '../faults.mjs';
import {MailboxDomain,actorOwner,readConfig} from '../store/mailbox.mjs';
import {IntakeDeliver} from './intake.mjs';

const part=value=>encodeURIComponent(String(value));
export const BRIDGE_KEYS=Object.freeze({settings:'bridge/settings',fingerprint:(consumer,fp)=>`bridge/fp/${part(consumer)}/${part(fp)}`});
// Fingerprints outlive the 7-day provenance window by a day; at most 32 expired rows are pruned per delivery.
export const BRIDGE_BOUNDS=Object.freeze({fingerprintMs:8*86400000,prunePerDelivery:32,maxConsumers:8});
const CHANNEL=/^[a-z][a-z0-9-]{0,63}$/;
export const defaultBridgeSettings=()=>({enabled:true,consumers:[]});
const notAuthorized=()=>{throw new ProtocolFault('not_authorized');};
const origin=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value?value:null;}catch{return null;}};

/** The `bridge` domain provider (catalogue row `bridge`): MailboxDomain owner binding, refused unless enabled. */
export function createBridgeProvider({BINDLEBOX_ENABLED=false}={}){
 return class BridgeDomain extends MailboxDomain {
  async obtain(params){if(BINDLEBOX_ENABLED!==true)fault('not_found','BindleBox is disabled.',404);return super.obtain(params);}
 };
}
const settingsOf=async store=>({...defaultBridgeSettings(),...await store.get(BRIDGE_KEYS.settings)});

// Owner switch and the application consumers (third-party bridges such as SMS) the owner allows, each bound to one
// channel. The owner's own provider needs no entry: it is the only consumer allowed for `email`.
export class BridgeConfigure extends MailboxAction {
 static operation='bridge.configure';static deps=['bridge'];
 async run({bridge}){
  actorOwner(this.actor);const input=this.input??{},config=await readConfig(bridge.store);
  if(Object.keys(input).some(k=>!['enabled','consumers'].includes(k)))fault('invalid_input','Unsupported bridge setting.',400);
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')fault('invalid_input','Choose on or off.',400);
  if(input.consumers!==undefined&&(!Array.isArray(input.consumers)||input.consumers.length>BRIDGE_BOUNDS.maxConsumers||input.consumers.some(c=>!c||typeof c!=='object'||Object.keys(c).some(k=>!['origin','channel'].includes(k))||!origin(c.origin)||c.origin===config.principal.issuer||!CHANNEL.test(c.channel??'')||c.channel==='email')||new Set(input.consumers.map(c=>c.origin)).size!==input.consumers.length))fault('invalid_input','Choose valid consumers.',400);
  return bridge.store.transaction(async tx=>{
   const s={...defaultBridgeSettings(),...await tx.get(BRIDGE_KEYS.settings)};
   if(input.enabled!==undefined)s.enabled=input.enabled;if(input.consumers!==undefined)s.consumers=input.consumers.map(c=>({origin:c.origin,channel:c.channel}));
   await tx.put(BRIDGE_KEYS.settings,s);return s;
  });
 }
}
export class BridgeSettings extends MailboxQuery {
 static operation='bridge.settings';static deps=['bridge'];
 async fetch({bridge}){actorOwner(this.actor);return settingsOf(bridge.store);}
}

export class BridgeReceive extends MailboxAction {
 static operation='bridge.receive';static deps=['bridge','receive','providerLink','clock'];static changes='incoming-changed';
 async run({bridge,receive,providerLink,clock}){
  actorOwner(this.actor,['ingress']);const {body,consumer,resource}=this.input??{},store=bridge.store,config=await readConfig(store);
  if(!(body instanceof Uint8Array))throw new ProtocolFault('malformed');
  const rpc=parseRPC(body,resource===undefined?{}:{resource});
  if(rpc.contract!==INTAKE_CONTRACT||rpc.method!=='deliver')throw new ProtocolFault('unsupported_contract',{status:200,rpc:true});
  // Consumer and channel before any key lookup or provenance crypto.
  if(typeof consumer!=='string'||!origin(consumer))notAuthorized();
  const settings=await settingsOf(store);
  const channel=consumer===config.principal.issuer?'email':settings.consumers.find(c=>c.origin===consumer)?.channel;if(!channel)notAuthorized();
  const claims=parseProvenance(rpc.args.provenance).claims;
  if(claims.channel!==channel||claims.iss!==consumer)notAuthorized();
  // The switch is read in the commit, after provenance verified (review LH-7): unverified requests learn nothing.
  const digest=await intakeDigest(rpc.args.message),fpKey=BRIDGE_KEYS.fingerprint(consumer,claims.ingressFingerprint),now=clock.now();
  // B2's verified admission, with the fingerprint dedup and the live switch in the same commit. Provenance is verified
  // before this transaction runs, so a dedup answer is never given to an unverified request.
  const guarded={get:key=>receive.store.get(key),list:options=>receive.store.list(options),transaction:work=>receive.store.transaction(async tx=>{
   const live={...defaultBridgeSettings(),...await tx.get(BRIDGE_KEYS.settings)};if(!live.enabled)return {disposition:'refused'};
   const seen=await tx.get(fpKey);
   if(seen&&seen.until>now){if(seen.digest!==digest)fault('operation_conflict','The operation conflicts with an earlier one.',409);return {disposition:seen.disposition};}
   const result=await work(tx);
   await tx.put(fpKey,{digest,disposition:result.disposition,jti:claims.jti,until:now+BRIDGE_BOUNDS.fingerprintMs});
   let pruned=0;for(const [key,row] of await tx.list({prefix:'bridge/fp/'})){if(pruned>=BRIDGE_BOUNDS.prunePerDelivery)break;if(!(row?.until>now)){await tx.delete(key);pruned++;}}
   return result;
  })};
  const intake=new IntakeDeliver({actor:this.actor,input:{tx:rpc.tx,contract:INTAKE_CONTRACT,consumer,args:rpc.args}});
  const result=await intake.run({receive:{...receive,store:guarded},providerLink,clock});
  return {disposition:result.disposition==='refused'?'refused':'stored-receipt'};
 }
}
export const BRIDGE_OPERATIONS=[BridgeConfigure,BridgeSettings,BridgeReceive];

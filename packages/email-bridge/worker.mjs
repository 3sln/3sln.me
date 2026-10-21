// BRIDGE Cloudflare adapter (no `cloudflare:*` import here, so Node tests load it). The Worker `email(message, env,
// ctx)` handler: Email Routing hands us a ForwardableEmailMessage {from, to, headers, raw, rawSize, setReject(reason),
// reply(EmailMessage)} (https://developers.cloudflare.com/email-service/api/route-emails/email-handler/). `reply()`
// requires a valid DMARC result, one reply per event, the inbound sender as recipient and the receiving domain as the
// sending domain, so the reply is built here from raw bytes and sent only while the event is live.
//
// Everything fails closed: without EMAIL_BRIDGE_ENABLED and BINDLEBOX_ENABLED, the EMAIL_BRIDGE object binding, the
// identity directory, a current-entitlement answer, a provenance key or a brokered occupant port, mail is either
// refused with the one generic reason or held undelivered. Ports not yet provided by core answer "unavailable".
import {bridgeKey} from './keys.mjs';
import {ShardedIdentityRepository} from '../runtime/identity-shards.mjs';
import {readBounded} from './mime.mjs';
import {createBridgeEngine,perform,read,bridgeConfig,BridgeReceive,BRIDGE_OPERATIONS,GENERIC_REFUSAL,storeSenders,provenanceSigner,brokeredOccupant} from './engine.mjs';

const OWNER=/^[a-f0-9-]{36}$/;
export const SENDER_SHARDS=16;
export const bridgeObjectName=owner=>`owner/${owner}`;
const nullAudit={record(){}};
const effects={clock:{now:()=>Date.now()},random:{uuid:()=>crypto.randomUUID()},audit:nullAudit};
const accountCall=async(env,owner,method,args)=>{const out=await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(owner)).invoke({method,args:[owner,...args]});if(out?.$fault)throw Object.assign(new Error(out.$fault.message),out.$fault);return out;};

/** Edge ports: handle directory, entitlement, ingress budget and the owner placement. */
export function workerEdgePorts(env){
 const repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT,config:env});
 const origin=bridgeConfig(env).origin;
 return {
  directory:{async resolve(handle){
   let account;try{account=await repository.findByHandle(handle);}catch{return null;}if(!account||!OWNER.test(account.id??''))return null;
   // Current confirmed paid entitlement; a failing account lookup makes the recipient ineligible.
   let entitled=false;try{entitled=await accountCall(env,account.id,'emailBridgeEntitled',[])===true;}catch{entitled=false;}
   return {owner:account.id,active:account.status==='active',entitled,principal:{issuer:origin,subject:account.id,identityURI:`${origin}/identity/${account.id}`}};
  }},
  limiter:{consume:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consume(limits)},
  owners:{admit:(owner,input)=>env.EMAIL_BRIDGE.get(env.EMAIL_BRIDGE.idFromName(bridgeObjectName(owner))).operate('bridge.admit',owner,input)},
 };
}
let signerCache;
async function workerSigner(env){
 if(signerCache&&signerCache.source===JSON.stringify([env.EMAIL_BRIDGE_SIGNING_JWK,env.APP_ORIGIN,bridgeConfig(env).enabled]))return signerCache.signer;
 let signer=provenanceSigner({});
 const key=await bridgeKey(env);if(key)signer=provenanceSigner(key);
 signerCache={source:JSON.stringify([env.EMAIL_BRIDGE_SIGNING_JWK,env.APP_ORIGIN,bridgeConfig(env).enabled]),signer};return signer;
}
/** Owner-placement ports (inside EmailBridgeObject): sender shards, the brokered occupant, the bridge key, follow-up mail. */
export async function workerOwnerPorts(env,storage){
 const shard=async key=>{const d=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)));return env.EMAIL_BRIDGE.get(env.EMAIL_BRIDGE.idFromName(`senders/${d[0]%SENDER_SHARDS}`));};
 const sender=method=>async(key,options)=>(await shard(key)).senders(method,key,options);
 const domain=env.MAIL_SENDER_DOMAIN??(bridgeConfig(env).origin?new URL(bridgeConfig(env).origin).hostname:'');
 return {
  stores:{for:()=>storage},
  senders:{consume:sender('consume'),refund:sender('refund'),suppressed:sender('suppressed'),suppress:sender('suppress')},
  // X7 provider-feature call; the account rechecks current entitlement, record and seat before delivery.
  occupant:brokeredOccupant({seat:async owner=>{try{return await accountCall(env,owner,'integrationsIntakeSeat',[])??null;}catch{return null;}},call:async({owner,seat,body})=>accountCall(env,owner,'integrationsIntakeDeliver',[{seat,body}])}),
  signer:await workerSigner(env),
  // Follow-ups use the existing onboarded system sender role; Auto-Submitted and X- headers are allowlisted by EMAIL.send.
  mail:env.MAIL_ENABLED==='true'&&typeof env.EMAIL?.send==='function'&&domain?{send:async({to,subject,text,headers})=>{const r=await env.EMAIL.send({from:`notify@${domain.toLowerCase()}`,to,subject,text,headers});return {messageId:r?.messageId??null};}}:{},
 };
}

/** One owner-placement operation inside the object (also the sender shard RPC). */
export async function runOwnerOperation(env,storage,operation,owner,input){
 const Operation=BRIDGE_OPERATIONS[operation];if(!Operation||operation==='bridge.receive'||!OWNER.test(owner??''))throw Object.assign(new Error('Not found.'),{code:'not_found'});
 const bound=await storage.get('@owner');if(bound!==undefined&&bound!==owner)throw Object.assign(new Error('Owner mismatch.'),{code:'forbidden'});if(bound===undefined)await storage.put('@owner',owner);
 const engine=createBridgeEngine({providers:{config:env,...effects,...await workerOwnerPorts(env,storage)}});
 try{const op=new Operation({actor:{kind:operation==='bridge.configure'?'owner':'system',owner},input});return op instanceof BridgeReceive?null:await (operation==='bridge.settings'||operation==='bridge.status'?read(engine,op):perform(engine,op));}finally{engine.dispose();}
}
export const runSenderMethod=(storage,method,key,options)=>{if(!['consume','refund','suppressed','suppress'].includes(method))throw Object.assign(new Error('Not found.'),{code:'not_found'});return storeSenders(storage)[method](key,options);};

/** The Worker `email` handler. `EmailMessage` is the `cloudflare:email` constructor and `edge` the edge ports, both
 * injectable so Node tests run the same adapter. */
export const RESPONSE_FLOOR_MS=1500;
export async function handleEmail(message,env,ctx,{EmailMessage,edge,floorMs=RESPONSE_FLOOR_MS,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 // Every outcome answers no sooner than a fixed floor (review EB-4), narrowing the timing difference between unknown,
 // unpaid, opted-out and accepted recipients. A residual remains for large accepted mail; SMTP cannot hide existence.
 const started=Date.now(),settle=async()=>{const wait=started+floorMs-Date.now();if(wait>0)await sleep(wait);};
 const reject=async()=>{await settle();try{message.setReject(GENERIC_REFUSAL);}catch{}};
 if(!bridgeConfig(env).enabled||!env.EMAIL_BRIDGE||!env.IDENTITIES||!env.ABUSE||!env.ACCOUNTS){await reject();return {action:'reject'};}
 const engine=createBridgeEngine({providers:{config:env,...effects,...edge??workerEdgePorts(env)}});let out=null;
 try{out=await perform(engine,new BridgeReceive({actor:{kind:'edge'},input:{envelope:{from:message.from,to:message.to},rawSize:message.rawSize,read:limit=>readBounded(message.raw,limit),dmarcGate:typeof EmailMessage==='function'?'platform':'unavailable'}}));}
 catch{out=null;}finally{engine.dispose();}
 // Storage durability not established means never reporting acceptance.
 if(out?.action!=='accept'){await reject();return {action:'reject'};}
 const object=owner=>env.EMAIL_BRIDGE.get(env.EMAIL_BRIDGE.idFromName(bridgeObjectName(owner)));
 if(out.reply){
  let outcome='sent',code;try{await message.reply(new EmailMessage(out.reply.from,out.reply.to,new TextDecoder().decode(out.reply.raw)));}catch(error){outcome='failed';code=typeof error?.code==='string'?error.code:undefined;}
  try{await object(out.owner).operate('bridge.reply-outcome',out.owner,{jti:out.reply.jti,outcome,...code?{code}:{}});}catch{}
 }
 // A prompt delivery attempt; the object's alarm is the durable retry (waitUntil alone is not a work queue).
 ctx?.waitUntil?.(object(out.owner).operate('bridge.drain',out.owner,{}).catch(()=>{}));
 await settle();
 return {action:'accept',replied:!!out.reply};
}

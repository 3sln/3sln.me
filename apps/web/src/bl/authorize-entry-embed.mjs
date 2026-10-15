// Popup side of the frame-initiated sign-in bridge (adaptive-app-sign-in §7.3–7.4, §9; slice A7). The frame side is
// apps/embed/src/bridge.mjs. This document is served without COOP only for live `embed-popup` entries, so it keeps
// its opener; it shows nothing until the opener proves the entry's key (hello → proof → embed-verify). Messages
// go only to `window.opener` with targetOrigin = the configured embed origin (never '*'), and replies are accepted
// only from that same WindowProxy at that exact origin with exact schemas. The hello carries the entry ID and a
// server challenge; `done` carries only {code,state,iss,claim}. No account state ever crosses this channel.
export const HANDSHAKE_MS=3000,ACK_MS=3000;
const COMPONENTS_PROFILE='https://3sln.me/artefacts/profiles/components/v1';
const exact=(value,keys)=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const JWT=/^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,512}$/;
/** The dedicated embed origin: from the entry view when the server provides it, else the issuer's own components
 * profile declaration. Anything that is not a distinct serialized origin yields null (plain mode). */
export function embedOriginFor({entry,manifest,issuer}){
 const candidate=entry?.embed?.origin??manifest?.profiles?.[COMPONENTS_PROFILE]?.embed_origin;
 if(typeof candidate!=='string'||candidate.length>256)return null;
 try{const url=new URL(candidate);return url.origin===candidate&&candidate!==issuer&&['https:','http:'].includes(url.protocol)?candidate:null;}catch{return null;}
}
export const validProof=data=>exact(data,['v','type','proof'])&&data.v===1&&data.type==='bindle-embed-proof'&&typeof data.proof==='string'&&data.proof.length<=4096&&JWT.test(data.proof);
export const validAck=(data,entryId)=>exact(data,['v','type','entry'])&&data.v===1&&data.type==='bindle-embed-ack'&&data.entry===entryId;
/** Waits for one message from `source` at `origin` that passes `accept`; resolves null on timeout. */
function awaitMessage(win,{source,origin,accept,timeoutMs,setTimer=setTimeout,clearTimer=clearTimeout}){
 return new Promise(resolve=>{let timer=null;const listener=event=>{if(event.source!==source||event.origin!==origin||!accept(event.data))return;done(event.data);};
  const done=value=>{win.removeEventListener('message',listener);clearTimer(timer);resolve(value);};
  win.addEventListener('message',listener);timer=setTimer(()=>done(null),timeoutMs);});
}
/** Opener-key handshake. Returns the per-page secret, or null for plain mode (no opener, no proof in time, refused). */
export async function runHandshake({win,api,entryId,embedOrigin,timeoutMs=HANDSHAKE_MS,timers={}}){
 const opener=win.opener;if(!opener||!embedOrigin)return null;
 let challenge;try{({challenge}=await api.post(`/oauth/entries/${entryId}/embed-challenge`,{}));}catch{return null;}
 if(typeof challenge!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(challenge))return null;
 // The listener is armed before the hello so a fast frame cannot be missed.
 const reply=awaitMessage(win,{source:opener,origin:embedOrigin,accept:validProof,timeoutMs,...timers});
 try{opener.postMessage({v:1,type:'bindle-embed-hello',entry:entryId,challenge},embedOrigin);}catch{return null;}
 const message=await reply;if(!message)return null;
 try{const {pageSecret}=await api.post(`/oauth/entries/${entryId}/embed-verify`,{proof:message.proof});return typeof pageSecret==='string'&&/^[A-Za-z0-9_-]{43}$/.test(pageSecret)?pageSecret:null;}catch{return null;}
}
/** Posts the approval to the attested opener and waits for its acknowledgement. False means: use the callback. */
export async function deliverToOpener({win,embedOrigin,entryId,result,timeoutMs=ACK_MS,timers={}}){
 const opener=win.opener;if(!opener||!embedOrigin)return false;
 const ack=awaitMessage(win,{source:opener,origin:embedOrigin,accept:data=>validAck(data,entryId),timeoutMs,...timers});
 try{opener.postMessage({v:1,type:'bindle-embed-done',entry:entryId,code:result.code,state:result.state,iss:result.iss,claim:result.claim},embedOrigin);}catch{return false;}
 return Boolean(await ack);
}

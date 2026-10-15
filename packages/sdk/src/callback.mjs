// Callback page support for the embeddable elements (design §6.2, decision D7).
// Load this module first on the registered callback page, served with
// `Referrer-Policy: no-referrer`, before analytics or third-party scripts.
//
// One deterministic handleCallback(): when this tab holds the pending
// transaction for the returned state it completes in place (redirect mode);
// otherwise it relays the callback parameters to the waiting app tab over a
// same-origin BroadcastChannel (popup mode). The pending PKCE verifier lives in
// the opener tab's sessionStorage, so a relayed code is useless anywhere else,
// and the waiting tab still runs the full single-use completeLogin validation.
import {createSdkLocalization} from '../../i18n/sdk-catalogue.mjs';

import {relayParameters,callbackChannelName,parseRelayMessage,relayCallbackUrl} from './relay.mjs';
export {relayParameters,callbackChannelName,parseRelayMessage,relayCallbackUrl};

function pendingInStorage(storage,state,prefix){
  // Scans this tab's SDK transactions without needing the client configuration.
  // Returns 'live', 'expired', 'other' (some transaction for another state) or null.
  let found=null;
  try{
    for(let index=0;index<(storage?.length??0);index++){
      const key=storage.key(index);
      if(!key?.startsWith(prefix+':'))continue;
      const pending=JSON.parse(storage.getItem(key));
      if(pending?.state===state)return pending.expiresAt>Date.now()?'live':'expired';
      if(pending)found='other';
    }
  }catch{}
  return found;
}

export async function handleCallback({session,client=session?.client,location=globalThis.location,history=globalThis.history,storage=globalThis.sessionStorage,storageKey=client?.storageKey??'bindle.pending-login',BroadcastChannel:Channel=globalThis.BroadcastChannel,crypto=globalThis.crypto,document=globalThis.document,window=globalThis.window,render=true,close=true,ackTimeout=1000,lang}={}){
  const url=new URL(location.href),state=url.searchParams.get('state');
  // Only a complete provider callback (state, iss, and exactly one of code/error/result)
  // is ever handled, so an arbitrary ?state= link cannot make the page relay or blank itself.
  const kinds=['code','error','result'].filter(key=>url.searchParams.has(key));
  if(!state||!url.searchParams.has('iss')||kinds.length!==1)return {mode:'none'};
  // Redirect mode: this tab started the transaction and can redeem it itself.
  if(client?.hasPending?.(state)){
    if(session?.completeCallback)return {mode:'redirect',...await session.completeCallback(url.href)};
    try{await client.completeCallback(url.href);return {mode:'redirect',outcome:'completed'};}catch(error){return {mode:'redirect',outcome:error.code==='canceled'?'canceled':'network-error',code:error.code};}
  }
  const local=pendingInStorage(storage,state,storageKey);
  if(!client&&local==='live')return {mode:'redirect-pending'};
  // From here on the parameters are consumed or relayed: scrub the address bar first.
  const message={v:1,type:'bindle-callback'};let valid=true;
  for(const key of relayParameters){const values=url.searchParams.getAll(key);if(values.length>1)valid=false;if(values.length===1)message[key]=values[0];}
  const clean=new URL(url.href);for(const key of [...relayParameters,'error_description'])clean.searchParams.delete(key);
  try{history?.replaceState(null,'',clean.pathname+clean.search+clean.hash);}catch{}
  const {t}=createSdkLocalization({locale:lang??document?.documentElement?.lang??globalThis.navigator?.language});
  const show=text=>{if(render&&document?.body){const paragraph=document.createElement('p');paragraph.setAttribute('role','status');paragraph.textContent=text;document.body.replaceChildren(paragraph);}};
  // Only an expired record for THIS state means "expired". A popup can inherit a copy of the opener's
  // sessionStorage, so other records never block the relay; the waiting tab's single-use check decides.
  if(local==='expired'||client?.readPending?.(state)){show(t('This sign-in expired or was replaced. Return to the app and try again.'));return {mode:'expired'};}
  if(!valid||!parseRelayMessage(message)){show(t('This sign-in response was not valid. Return to the app and try again.'));return {mode:'relay',relayed:false};}
  if(typeof Channel!=='function'){show(t('Return to the app and choose Continue in this tab.'));return {mode:'unavailable'};}
  const channel=new Channel(await callbackChannelName(state,crypto));
  // The waiting tab acknowledges. Without an ack (the app tab was reloaded, closed,
  // or the sign-in was replaced) the user is told to continue in the app instead.
  const acknowledged=new Promise(resolve=>{
    const timer=setTimeout(()=>resolve(false),ackTimeout);
    channel.onmessage=event=>{const data=event.data;if(data&&data.v===1&&data.type==='bindle-callback-ack'&&data.state===state){clearTimeout(timer);resolve(true);}};
  });
  try{channel.postMessage(message);}catch{channel.close();show(t('Return to the app and choose Continue in this tab.'));return {mode:'unavailable'};}
  const ack=await acknowledged;channel.close();
  if(!ack){show(t('This sign-in expired or was replaced. Return to the app and try again.'));return {mode:'relay',relayed:true,acknowledged:false};}
  // Closing is best effort: after the COOP browsing-context swap, or when iOS
  // opens the popup as a tab, window.close() may do nothing (EE-11).
  show(t('Return to {host}. You can close this window.',{host:url.host}));
  if(close)try{window?.close();}catch{}
  return {mode:'relay',relayed:true,acknowledged:true};
}

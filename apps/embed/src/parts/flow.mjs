// Island-initiated flows (profile §8; embed-islands §4.3–4.4). The intent comes only from the activated control.
// `prepare` is stored, never acted on, and consumed by one flow. `flow{ended}` follows every `flow{started}`
// exactly once with a generic outcome; `code` goes out only when the parent origin verified at init equals the
// origin of the flow's redirectUri, and only between started and ended. When delivery is impossible (no
// prepare, origin mismatch, sandboxed, popup unavailable) the island opens nothing and reports `unavailable`.
// v1 controls all use intent `login` (profile §5.4).
//
// Transport (adaptive §11.3, §14): FedCM inside the island when the shell config names the provider's FedCM
// endpoints, the browser has IdentityCredential and this frame was delegated `identity-credentials-get`; otherwise
// the frame-initiated popup. The choice is made synchronously in the activation, because a popup can only open
// there. FedCM uses `mediation:'required'` (never auto-selected, so every embed credential follows an explicit
// choice) and a frame-key proof over a single-use server nonce, bound to an `embed-fedcm` entry.
import {openPopup,runPopupFlow} from '../bridge.mjs';
// Errors raised before any browser UI could show; any other rejection may be a user dismissal (generic by design).
const beforeUI=new Set(['NotAllowedError','NotSupportedError','SecurityError','InvalidStateError']);
const opaque=value=>typeof value==='string'&&/^[\x21-\x7e]{1,2048}$/.test(value);
/** The assertion token: JSON text (or, from Chrome 143, an object) `{v:1, code, state, iss, claim?}` (profile §9.1). */
export function readFedcmToken(token,{state,issuer}){
  let value=token;if(typeof value==='string'){try{value=JSON.parse(value);}catch{return null;}}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return null;
  const keys=Object.keys(value).sort().join();if(keys!=='code,iss,state,v'&&keys!=='claim,code,iss,state,v')return null;
  if(value.v!==1||value.state!==state||value.iss!==issuer||!opaque(value.code))return null;
  if('claim' in value&&!(typeof value.claim==='string'&&/^[A-Za-z0-9._~-]{32,256}$/.test(value.claim)))return null;
  return Object.freeze({code:value.code,state:value.state,iss:value.iss,claim:value.claim??null});
}
/** FedCM in frame is attempted only when every precondition is visible synchronously (feature detection). */
export function fedcmUsable({fedcm,win=globalThis.window,doc=globalThis.document}){
  if(!fedcm||typeof win?.IdentityCredential!=='function'||typeof win.navigator?.credentials?.get!=='function')return false;
  const policy=doc?.permissionsPolicy??doc?.featurePolicy;
  try{return policy?.allowsFeature?.('identity-credentials-get')===true;}catch{return false;}
}
export function createFlows({model,send,worker,issuer,clientId,fedcm=null,win=globalThis.window,doc=globalThis.document,refresh=()=>{}}){
  const end=(outcome,used)=>{model.flow=null;if(model.prepare===used)model.prepare=null;send({v:1,type:'flow',phase:'ended',outcome});refresh();};
  // The code goes to the app first; the claim is redeemed only for a binding whose code really reached it (IMPL-9).
  async function deliver(client,result,used){
    const delivered=send({v:1,type:'code',code:result.code,state:result.state,iss:result.iss});
    if(result.claim)try{await client.call('redeem',{claim:result.claim,delivered});}catch{}
    end('completed',used);
  }
  async function viaFedcm(prepare){
    let client,entry,proof;
    try{client=await worker();entry=await client.call('createEntry',{prepare,delivery:'embed-fedcm'});proof=await client.call('fedcmProof',{entry,assertUrl:fedcm.assertUrl});}
    catch{end('unavailable',prepare);return;}
    let credential;
    try{credential=await win.navigator.credentials.get({identity:{providers:[{configURL:fedcm.configUrl,clientId,params:{v:1,entry,proof}}],mode:'active',context:'signin'},mediation:'required'});}
    catch(error){end(beforeUI.has(error?.name)?'unavailable':'canceled',prepare);return;}
    // An auto-selected assertion carries no claim (C5): the app still gets its code, the island no binding.
    const result=readFedcmToken(credential?.token,{state:prepare.state,issuer});
    if(!result){end('canceled',prepare);return;}
    await deliver(client,result,prepare);
  }
  /** Call synchronously from a trusted, armed activation. */
  return function start(){
    if(model.flow)return;
    const prepare=model.prepare,deliverable=Boolean(prepare)&&(()=>{try{return new URL(prepare.redirectUri).origin===model.parentOrigin;}catch{return false;}})();
    model.flow='pending';send({v:1,type:'flow',phase:'started'});refresh();
    if(model.sandboxed||!deliverable){end('unavailable',prepare);return;}
    if(fedcmUsable({fedcm,win,doc})){viaFedcm(prepare);return;}
    const popup=openPopup(win);if(!popup){end('unavailable',prepare);return;}
    (async()=>{
      let client;try{client=await worker();}catch{try{popup.close();}catch{}end('unavailable',prepare);return;}
      const result=await runPopupFlow({win,popup,issuer,prepare,createEntry:()=>client.call('createEntry',{prepare}),prove:args=>client.call('proof',args)});
      if(result.outcome!=='completed'){end(result.outcome,prepare);return;}
      await deliver(client,result,prepare);
    })();
  };
}

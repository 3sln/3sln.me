// Frame-initiated popup bridge (adaptive-app-sign-in §7.2–7.4, profile §9.1; slice A5). Document side.
// COOP spike (docs/release/coop-opener-spike.md, Chromium 156 / Firefox 157): the popup keeps `opener` only if
// the provider page sends no COOP; it must be unnamed (a named window is reachable from the app with
// window.open('', name)); window.open returns null under an app `COOP: same-origin` even though a window opens,
// and throws in Firefox inside a sandbox without allow-popups. Every such case is reported as `unavailable`.
// Messages are accepted only from our own popup handle, from the issuer origin, for our pending entry, with
// exact schemas; replies go only to that handle with targetOrigin = issuer (never '*').
const keys=(value,required)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===required.length&&required.every(k=>Object.hasOwn(value,k));
const B64=(min,max)=>value=>typeof value==='string'&&value.length>=min&&value.length<=max&&/^[A-Za-z0-9_-]+$/.test(value);
export const FLOW_TIMEOUT_MS=600000,POLL_MS=500,MAX_HELLOS=3;
export function validateHello(data,entry){return keys(data,['v','type','entry','challenge'])&&data.v===1&&data.type==='bindle-embed-hello'&&data.entry===entry&&B64(16,128)(data.challenge);}
export function validateDone(data,{entry,state,issuer}){return keys(data,['v','type','entry','code','state','iss','claim'])&&data.v===1&&data.type==='bindle-embed-done'&&data.entry===entry&&data.state===state&&data.iss===issuer&&typeof data.code==='string'&&/^[\x21-\x7e]{1,2048}$/.test(data.code)&&typeof data.claim==='string'&&/^[A-Za-z0-9._~-]{32,256}$/.test(data.claim);}

/** Must run synchronously inside the trusted activation. Returns the private handle or null. */
export function openPopup(win=globalThis.window){
  let popup=null;try{popup=win.open('about:blank','_blank','popup');}catch{popup=null;}
  return popup&&typeof popup.closed==='boolean'?popup:null;
}

/** Drives one flow on an already opened popup. Resolves {outcome, code?, claim?}; never rejects. */
export function runPopupFlow({win=globalThis.window,popup,issuer,prepare,createEntry,prove,authorizationEndpoint=`${issuer}/oauth/authorize`,timeoutMs=FLOW_TIMEOUT_MS,pollMs=POLL_MS}){
  return new Promise(resolve=>{
    let entry=null,hellos=0,done=false,poll=null,deadline=null;
    const finish=result=>{if(done)return;done=true;win.removeEventListener('message',onMessage);clearInterval(poll);clearTimeout(deadline);if(result.outcome!=='completed')try{popup.close();}catch{}resolve(result);};
    async function onMessage(event){
      if(done||!entry||event.source!==popup||event.origin!==issuer)return;const data=event.data;
      if(validateHello(data,entry)&&hellos<MAX_HELLOS){hellos++;try{const proof=await prove({entry,challenge:data.challenge});if(!done)popup.postMessage({v:1,type:'bindle-embed-proof',proof},issuer);}catch{}return;}
      if(validateDone(data,{entry,state:prepare.state,issuer})){popup.postMessage({v:1,type:'bindle-embed-ack',entry},issuer);finish({outcome:'completed',code:data.code,state:data.state,iss:data.iss,claim:data.claim});}
    }
    win.addEventListener('message',onMessage);
    // Closed before any valid hello: the opener was lost (plain mode, COOP) rather than a user cancel (U1).
    poll=setInterval(()=>{let closed=true;try{closed=popup.closed;}catch{}if(closed)finish({outcome:hellos?'canceled':'unavailable'});},pollMs);
    deadline=setTimeout(()=>finish({outcome:'canceled'}),timeoutMs);
    createEntry().then(id=>{if(done)return;entry=id;try{popup.location.replace(`${authorizationEndpoint}?entry=${encodeURIComponent(id)}`);}catch{finish({outcome:'unavailable'});}},()=>finish({outcome:'unavailable'}));
  });
}

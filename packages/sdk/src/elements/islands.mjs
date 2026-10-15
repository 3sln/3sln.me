// Island mounter (components profile §3–§8, §10 E1–E10; embed-islands §4, §8.2, §10–§12). Loaded lazily by
// shared.mjs only when the capability set lists the part, so the embedder's islands="auto|off" and
// island-issuers policy and the profile cross-checks have already passed.
//
//   mountIsland({element, container, session, onState, part, issuer, embedOrigin, version, fedcm, themeTokens})
//     element    the host element (its lang, theme, attributes and computed --bindle-* tokens; never its light DOM)
//     container  an empty element in the host's shadow root; the iframe is appended to it and sized to fill it
//     session    the <bindle-session> element; its controller provides prepareIsland(issuer),
//                completeIslandCode({code,state,iss}), selectAccount(subject) and the `change`/`sign-out` events
//     onState(s) 'mounting' | 'live' | 'fallback'; elements show the island only while 'live'
//   returns null (not mounted) or {destroy(), refresh(), forget(subject?)}
//
// Island messages reach elements only as translated calls on the host: element.islandFlow(phase, outcome, code)
// (after a completed flow, only once the app credential is ready or has failed), element.islandSelect(subject)
// and element.islandClose('escape'|'dismiss'). Raw port data never reaches app events (E3). Timeout, schema
// violations, a mismatched `ready`, attribute tampering or a second load tear the island down and degrade the
// part (or, for a foreign `ready.issuer`, the whole profile) for this issuer and document (E5, profile §11).
import {islandURL,formatIslandName,validateOutbound,validateThemeTokens,PARTS,LIMITS} from '../islands-protocol.mjs';
import {localeFor,localize,schemeFor} from './shared.mjs';

// Features islands never need (profile §3.1): naming them 'none' disables those with a default allowlist of *.
const denied="storage-access 'none'; browsing-topics 'none'; attribution-reporting 'none'; shared-storage 'none'; join-ad-interest-group 'none'; run-ad-auction 'none'; private-aggregation 'none'; sync-xhr 'none'";
// Localized frame titles (the frame's accessible name). The sign-in title follows the island's label.
const titleFor=(element,part,host)=>{const {t}=localize(element);if(part==='avatar')return t('Identity picture');if(part==='account-switcher')return t('Account');return element.getAttribute('island-label')==='sign-in'?t('Sign in with Bindle'):t('Continue with {host}',{host});};
// Firefox fires no `load` for a frame refused by frame-src/frame-ancestors or a failed navigation, so a frame that
// has not loaded by this deadline is treated like a handshake timeout (embed-islands §11).
const LOAD_MS=10000;
// Per controller (one app's <bindle-session>), so one app's sign-out never reaches another app's islands (E4).
const registries=new WeakMap();
const group=(map,issuer)=>{let set=map.get(issuer);if(!set)map.set(issuer,set=new Set());return set;};
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
// App sign-out tells every live island of the issuer to forget the ended subjects (EI-12), and queues them for
// islands mounted later in this document; a later app sign-in as that subject withdraws the queued forget.
function watch(controller){
  let registry=registries.get(controller);if(registry)return registry;
  registry={live:new Map(),queued:new Map()};registries.set(controller,registry);
  controller.addEventListener('sign-out',event=>{for(const {issuer,subject} of event.detail?.sessions??[]){group(registry.queued,issuer).add(subject);for(const island of registry.live.get(issuer)??[])island.forget(subject);}});
  controller.addEventListener('change',()=>{const view=controller.session;if(view)registry.queued.get(view.issuer)?.delete(view.subject);});
  return registry;
}

export async function mountIsland({element,container,session,onState=()=>{},part,issuer,embedOrigin,version=1,fedcm=false,themeTokens=[]}){
  const controller=session?.controller,client=controller?.client,clientId=client?.clientIdFor?.(issuer),spec=PARTS[part];
  const doc=element.ownerDocument,win=doc?.defaultView;
  if(!controller||!clientId||!embedOrigin||!spec||!container||!win?.MessageChannel)return null;
  const {live,queued}=watch(controller);
  const host=new URL(issuer).host,interactive=spec.inbound.includes('prepare');
  const lang=()=>{const value=localeFor(element);return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(value)&&value.length<=LIMITS.lang?value:'en';};
  // One resolved scheme for name, iframe color-scheme and the `scheme` message (EIR-12).
  const scheme=()=>{
    const {theme}=schemeFor(element,session);if(theme==='light'||theme==='dark')return theme;
    const used=win.getComputedStyle?.(element)?.colorScheme??'',dark=/\bdark\b/.test(used),light=/\blight\b/.test(used);
    return dark!==light?(dark?'dark':'light'):win.matchMedia?.('(prefers-color-scheme: dark)')?.matches?'dark':'light';
  };
  // Only declared, validated tokens; canonical #rrggbb colours and an integer radius (profile §7).
  const tokens=colorScheme=>{
    const style=win.getComputedStyle?.(element),input={};
    for(const name of themeTokens){const raw=style?.getPropertyValue?.(`--bindle-${name}`)?.trim().toLowerCase();if(!raw)continue;if(name==='radius'){if(/^\d{1,2}$/.test(raw))input.radius=Number(raw);}else if(/^#[0-9a-f]{6}$/.test(raw))input[name]=raw;}
    return validateThemeTokens(input,{scheme:colorScheme}).tokens;
  };
  const props=()=>{
    if(part==='account-switcher'){const value=element.getAttribute('actions'),requested=value===null?['switch','manage']:value.split(/\s+/);return {density:element.getAttribute('density')==='compact'?'compact':'regular',actions:[...requested.includes('switch')?['use-another']:[],...requested.includes('manage')?['manage']:[],'remove']};}
    if(part==='sign-in')return {label:['sign-in','sign-up'].includes(element.getAttribute('island-label'))?element.getAttribute('island-label'):'continue',variant:element.getAttribute('island-variant')==='outline'?'outline':'filled'};
    return {};
  };
  let current={lang:lang(),scheme:scheme()};current.tokens=JSON.stringify(tokens(current.scheme));current.props=JSON.stringify(props());
  let calls=Promise.resolve(),state='mounting',port=null,loads=0,loadAt=0,timer=null,observer=null,lastSubject,flowOpen=false,prepared=null,exchange=null,themeSeq=0,propsSeq=0;
  const violations=[],rate=[],nonce=b64(win.crypto.getRandomValues(new Uint8Array(16)));
  const set=value=>{if(state!==value){state=value;onState(value);}};
  const post=message=>{if(state==='live')try{port.postMessage(message);}catch{}};

  const iframe=doc.createElement('iframe');
  // src and name are set before insertion, so the initial about:blank never counts as a load (profile §3.1).
  iframe.src=islandURL(embedOrigin,clientId,part,version);
  iframe.name=formatIslandName({nonce,lang:current.lang,colorScheme:current.scheme});
  iframe.title=titleFor(element,part,host);
  iframe.setAttribute('referrerpolicy','no-referrer');iframe.setAttribute('loading','eager');
  iframe.setAttribute('allow',`identity-credentials-get ${fedcm&&interactive?"'src'":"'none'"}; ${denied}`);
  const coarse=win.matchMedia?.('(pointer: coarse)')?.matches,scale=Number.parseFloat(win.getComputedStyle?.(doc.documentElement)?.fontSize)/16||1;
  Object.assign(iframe.style,{display:'block',border:'0',margin:'0',padding:'0',background:'transparent',colorScheme:current.scheme,inlineSize:'100%',blockSize:part==='sign-in'?`${(coarse?48:44)*scale}px`:'100%'});
  if(part==='avatar'){iframe.setAttribute('aria-hidden','true');iframe.tabIndex=-1;iframe.style.pointerEvents='none';}

  function teardown(){
    clearTimeout(timer);observer?.disconnect();live.get(issuer)?.delete(handle);
    controller.removeEventListener('change',onSession);controller.removeEventListener('sign-out',onSignOut);
    try{port?.close();}catch{}port=null;iframe.removeEventListener('load',onLoad);iframe.remove();
  }
  function fail(scope='part'){
    if(state==='fallback'||state==='destroyed')return;
    const open=flowOpen;flowOpen=false;
    teardown();set('fallback');
    try{client.capabilities?.degrade?.(issuer,scope==='profile'?'profile':`part:${part}`);}catch{}
    // A flow cut off by teardown still ends exactly once for the element (after any exchange in flight).
    if(open)ended('unavailable',true);
  }
  function violation(){const now=Date.now();while(violations.length&&now-violations[0]>=LIMITS.violationWindowMs)violations.shift();violations.push(now);if(violations.length>=LIMITS.violations)fail();}
  // App sign-out clears every pending transaction, the prepared island one included: send a fresh prepare.
  function onSignOut(){if(!flowOpen){prepared=null;prepare();}}
  function onSession(){const view=controller.session,subject=view&&view.issuer===issuer?view.subject:null;if(subject===lastSubject)return;lastSubject=subject;post({v:1,type:'session',subject});}
  // Fresh in-memory PKCE/state for this issuer only (E4), after ready and after every flow end.
  async function prepare(){
    if(!interactive||state!=='live')return;
    let inputs;try{inputs=await controller.prepareIsland(issuer);}catch{return;}
    if(state!=='live'||flowOpen)return;prepared=inputs;
    const {redirectUri,challenge,state:value,requests,dpopJkt}=inputs;
    post({v:1,type:'prepare',redirectUri,challenge,state:value,requests:JSON.parse(JSON.stringify(requests??[])),uiLocales:[current.lang],colorScheme:current.scheme,...dpopJkt?{dpopJkt}:{}});
  }
  function forget(subject){
    if(subject!==undefined){try{if(new URL(subject).origin!==issuer)return;}catch{return;}}
    post({v:1,type:'forget',...subject!==undefined?{subject}:{}});
  }
  function becomeLive(){
    clearTimeout(timer);set('live');group(live,issuer).add(handle);
    controller.addEventListener('change',onSession);controller.addEventListener('sign-out',onSignOut);onSession();
    // Queued forgets go to every new island; a member island (worker starts at once) consumes them.
    const pending=queued.get(issuer);for(const subject of pending??[])forget(subject);if(part!=='sign-in')pending?.clear();
    prepare();
  }
  // A completed island flow ends only after the app's own exchange settles (EIR-17, profile §8). Per-flow state is
  // taken synchronously and element calls are serialized, so a next flow can never overtake or clobber this one.
  // When a code was exchanged, its result decides the outcome: the app's session is what the event reports.
  function ended(outcome,cutOff=false){
    const pending=exchange;exchange=null;prepared=null;
    calls=calls.then(async()=>{
      const result=pending?await pending:null;let mapped=outcome,code;
      if(result)({outcome:mapped,code}=result.outcome==='completed'?{outcome:'completed'}:{outcome:result.outcome==='canceled'?'canceled':'network-error',code:result.code??'network-error'});
      else if(outcome==='completed'){mapped='network-error';code='invalid-callback';}
      if(cutOff||state!=='destroyed')element.islandFlow?.('ended',mapped,code);
    });
    calls.then(()=>{if(!flowOpen)prepare();});
  }
  function onMessage(event){
    if(state==='fallback'||state==='destroyed')return;
    const data=event.data;
    if(state==='mounting'){
      // On timeout one macrotask is drained, and a ready stamped within the window still counts (profile §5.1).
      if(data?.type==='ready'&&typeof data.issuer==='string'&&data.issuer!==issuer&&validateOutbound(data,{part,version,issuer:data.issuer}))return fail('profile');
      const ready=!event.ports?.length&&validateOutbound(data,{part,version,issuer});
      if(ready?.type!=='ready'||!ready.protocol.includes(1)||event.timeStamp-loadAt>LIMITS.handshakeMs+50)return fail();
      return becomeLive();
    }
    // `flow` and `code` are never dropped (a lost `ended` would leave the flow open); the flow state machine bounds them,
    // since any extra one is a violation. Other types are limited to 10/s (profile §5.2).
    if(!['flow','code'].includes(data?.type)){const now=Date.now();while(rate.length&&now-rate[0]>=1000)rate.shift();if(rate.length>=LIMITS.ratePerSecond)return;rate.push(now);}
    const message=!event.ports?.length&&validateOutbound(data,{part,version,issuer});
    if(!message||message.type==='ready')return violation();
    if(message.type==='flow'){
      if(message.phase==='started'){if(flowOpen)return violation();flowOpen=true;exchange=null;calls=calls.then(()=>{if(state!=='destroyed')element.islandFlow?.('started');});return;}
      if(!flowOpen)return violation();flowOpen=false;ended(message.outcome);return;
    }
    // A code is accepted only on the port that received its prepare, between flow started and ended (E8).
    if(message.type==='code'){if(!flowOpen||exchange||!prepared||message.state!==prepared.state)return violation();exchange=controller.completeIslandCode({code:message.code,state:message.state,iss:message.iss});return;}
    if(message.type==='select'){element.islandSelect?.(message.subject);return;}
    element.islandClose?.(message.type);
  }
  function onLoad(event){
    if(++loads>1)return fail();clearTimeout(timer);
    const channel=new win.MessageChannel();port=channel.port1;port.onmessage=onMessage;loadAt=event.timeStamp;
    try{iframe.contentWindow.postMessage({v:1,type:'bindle-island-init',nonce,part,version,theme:{seq:themeSeq,tokens:JSON.parse(current.tokens)},locale:current.lang,colorScheme:current.scheme,props:{seq:propsSeq,...JSON.parse(current.props)}},embedOrigin,[channel.port2]);}catch{return fail();}
    timer=setTimeout(()=>setTimeout(()=>{if(state==='mounting')fail();},0),LIMITS.handshakeMs);
  }
  const handle=Object.freeze({
    destroy(){if(state==='destroyed')return;teardown();state='destroyed';},
    forget,
    // Re-reads embedder-side presentation inputs and sends only what changed (state messages, last-value-wins).
    refresh(){
      if(state!=='live')return;
      const next={lang:lang(),scheme:scheme()};next.tokens=JSON.stringify(tokens(next.scheme));next.props=JSON.stringify(props());
      if(next.scheme!==current.scheme){iframe.style.colorScheme=next.scheme;post({v:1,type:'scheme',colorScheme:next.scheme});}
      if(next.lang!==current.lang)post({v:1,type:'locale',lang:next.lang});
      const title=titleFor(element,part,host);if(iframe.title!==title)iframe.title=title;
      if(next.tokens!==current.tokens||next.scheme!==current.scheme)post({v:1,type:'theme',seq:++themeSeq,tokens:JSON.parse(next.tokens)});
      if(next.props!==current.props)post({v:1,type:'props',seq:++propsSeq,...JSON.parse(next.props)});
      current=next;
    },
  });
  iframe.addEventListener('load',onLoad);
  container.append(iframe);onState('mounting');
  timer=setTimeout(()=>{if(!loads)fail();},LOAD_MS);
  // Any embedder change to the frame's identity or permissions tears it down (E5); a reconnect mounts afresh.
  if(win.MutationObserver){observer=new win.MutationObserver(()=>fail());observer.observe(iframe,{attributes:true,attributeFilter:['src','name','sandbox','credentialless','allow']});}
  return handle;
}

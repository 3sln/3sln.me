// Headless Bindle session controller (embeddable-elements §3.1, §5, §6;
// components-profile decision note §5–§6). The custom elements are one renderer
// of this object; apps with their own UI use createSession() directly. It holds
// app state only, never provider state: before approval it knows what the user
// typed, afterwards only the approved identity and grants.
//
// Every behaviour is chosen per feature from the provider's declared capability
// set, for any Bindle provider. Provisional: `authorization-entry.v1` is reserved
// until its wire text is published; entry-based flows are verified against
// testing.mjs and the local 3sln reference handlers only.
import {BindleClient,parseIdentity} from './identity.mjs';
import {callbackChannelName,parseRelayMessage,relayCallbackUrl} from './relay.mjs';
import {createSdkLocalization} from '../../i18n/sdk-catalogue.mjs';

export const flowOutcomes=Object.freeze(['completed','canceled','dismissed','popup-blocked','discovery-error','network-error','redirecting']);
export const flowCodes=Object.freeze(['not-configured','invalid-identity','identity-required','discovery-unavailable','unsupported-provider','unregistered-client','no-provider','no-session','popup-blocked','network-error','invalid-callback']);
const discoveryCodes=new Set(['invalid-identity','identity-required','discovery-unavailable','unsupported-provider','unregistered-client','no-provider']);
// Product numbers from the design: show recovery actions after 2 s; entries expire after 10 minutes.
export const flowTimings=Object.freeze({lingerAfter:2000,entryLifetime:600000});
export const presentations=Object.freeze(['auto','popup','redirect']);
const fedcm=()=>import('./fedcm.mjs');

const freezeView=session=>{
  if(!session)return null;
  const view={issuer:session.issuer,subject:session.subject,grantedFragments:session.granted_fragments.map(({grant,fragment,digest,fields})=>Object.freeze({grant,fragment,digest,fields:Object.freeze([...fields])}))};
  // Profile fields appear only when granted and returned by the provider (provisional D1 field).
  const profile=session.profile;
  if(profile&&typeof profile==='object'&&!Array.isArray(profile)){
    // Bidi controls could reorder the label; such values are dropped, not rendered.
    const bidi=/[؜‎‏‪-‮⁦-⁩]/;
    const handle=typeof profile.handle==='string'&&profile.handle.length<=254&&/^[^\s@\x00-\x1f\x7f]+@[a-z0-9.-]+$/i.test(profile.handle)&&!bidi.test(profile.handle)?profile.handle:undefined;
    const displayName=typeof profile.displayName==='string'&&profile.displayName.trim()&&[...profile.displayName].length<=100&&!/[\x00-\x1f\x7f]/.test(profile.displayName)&&!bidi.test(profile.displayName)?profile.displayName.trim():undefined;
    // A granted picture is used only from the issuer's own origin (decision note §6.2).
    let picture;try{const url=new URL(profile.picture);if(typeof profile.picture==='string'&&profile.picture.length<=2048&&url.origin===session.issuer&&url.protocol==='https:'&&!url.username&&!url.password&&!url.hash)picture=url.href;}catch{}
    if(handle||displayName||picture)view.profile=Object.freeze({...handle?{handle}:{},...displayName?{displayName}:{},...picture?{picture}:{}});
  }
  view.grantedFragments=Object.freeze(view.grantedFragments);
  return Object.freeze(view);
};
const viewKey=view=>view?JSON.stringify(view):'';

export class BindleSession extends EventTarget {
  #client;#window;#channel;#crypto;#timers;#flow=null;#view=null;#viewKey='';#watched=null;#expiry=null;#t;#capabilityKey='';#unsubscribe;#fedcmFailures=new Map();
  constructor({client,clientId,clientMetadataUrl,redirectUri,presentation='auto',popupFallback='redirect',defaultHost='3sln.me',emailFallback=true,requests=[],uiLocales=[],colorScheme,transports=[],entryExtensions,islands='auto',islandIssuers=null,window:win=globalThis.window,BroadcastChannel:Channel=globalThis.BroadcastChannel,crypto=globalThis.crypto,timers=globalThis,localize,...clientOptions}={}){
    super();
    this.#client=client??new BindleClient({clientId,clientMetadataUrl,redirectUri,defaultHost,emailFallback,crypto,...clientOptions});
    this.#window=win;this.#channel=Channel;this.#crypto=crypto;this.#timers=timers;
    this.presentation=presentation;this.popupFallback=popupFallback;this.transports=transports;this.entryExtensions=entryExtensions;this.requests=requests;this.uiLocales=uiLocales;this.colorScheme=colorScheme;
    this.#client.islandPolicy={islands,issuers:islandIssuers};if(win)this.#client.userAgent={identityCredential:!!win.IdentityCredential};
    this.#t=localize??createSdkLocalization({locale:win?.navigator?.language}).t;
    this.#unsubscribe=this.#client.capabilities?.subscribe?.(()=>this.#capabilitiesChanged());
    this.#sync(false);
  }
  get client(){return this.#client;}
  get defaultHost(){return this.#client.defaultHost??'3sln.me';}
  set defaultHost(value){this.#client.defaultHost=value||'3sln.me';this.#capabilitiesChanged();}
  get presentation(){return this.#presentation;}
  set presentation(value){this.#presentation=presentations.includes(value)?value:'auto';}
  #presentation='auto';
  // Island policy (components profile §6.5): islands="auto|off" and an optional issuer allowlist.
  get islandPolicy(){return this.#client.islandPolicy;}
  set islandPolicy({islands='auto',issuers=null}={}){this.#client.islandPolicy={islands:islands==='off'?'off':'auto',issuers:Array.isArray(issuers)?[...issuers]:null};this.#capabilitiesChanged();}
  get session(){this.#sync();return this.#view;}
  // App state only. A pending flow never reveals provider state.
  get state(){const view=this.session;return view?'signed-in':this.#flow&&!this.#flow.done?'pending':'signed-out';}
  get flow(){const flow=this.#flow;return flow?Object.freeze({intent:flow.intent,phase:flow.phase,presentation:flow.presentation,host:flow.host,lingering:flow.lingering,fallback:flow.fallback,done:flow.done}):null;}
  get popupAvailable(){return typeof this.#channel==='function'&&typeof this.#window?.open==='function';}
  // The issuer whose capabilities the UI composes from: the current session's, else the default provider's.
  get capabilityIssuer(){return this.#client.session?.issuer??this.#client.defaultIssuer;}
  // Frozen capability set (decision note §5) for that issuer, or null before discovery.
  get capabilities(){return this.#client.capabilitiesFor(this.capabilityIssuer);}
  capabilitiesFor(issuer){return this.#client.capabilitiesFor(issuer);}
  // Discovers the capability issuer (public, cookieless metadata) so the first
  // click can choose its transport synchronously. Failures leave capabilities null.
  async loadCapabilities({signal}={}){
    const issuer=this.capabilityIssuer;if(!issuer)return null;
    try{await this.#client.discoverHost(new URL(issuer).host,{signal});}catch{return null;}
    if(this.capabilities?.fedcm)fedcm().catch(()=>{});
    this.#capabilitiesChanged();return this.capabilities;
  }
  #capabilitiesChanged(){
    const issuer=this.capabilityIssuer,capabilities=this.#client.capabilitiesFor?.(issuer)??null,key=JSON.stringify([issuer,capabilities]);
    if(key===this.#capabilityKey)return;this.#capabilityKey=key;
    this.#dispatch('capabilities-change',{issuer,capabilities});
  }

  // `host` names the provider for an identity-optional sign-in (default: the default host).
  signIn({identity,host}={}){return this.#begin('login',{identity:typeof identity==='string'&&identity.trim()?identity.trim():undefined,...typeof host==='string'&&host&&host!=='none'?{host}:{}});}
  // "Use another account" (CP-10): select-account when declared, else an
  // identity-optional login at the same provider, else a typed handle. The current
  // session stays current until the new credential is ready.
  switchAccount({revokePrevious=false,identity}={}){
    const session=this.#client.session;
    if(!session)return Promise.resolve(this.#announce('select-account',{outcome:'canceled',code:'no-session'}));
    if(typeof identity==='string'&&identity.trim())return this.#begin('login',{identity:identity.trim(),switching:true,revokePrevious});
    const capabilities=this.#client.capabilitiesFor(session.issuer);
    if(!capabilities||capabilities.selectAccount)return this.#begin('select-account',{revokePrevious});
    if(capabilities.identityless)return this.#begin('login',{host:new URL(session.issuer).host,switching:true,revokePrevious});
    return Promise.resolve(this.#announce('select-account',{outcome:'canceled',code:'identity-required'}));
  }
  reauthenticate({maxAge=300}={}){return this.#begin('reauthenticate',{maxAge});}
  endProviderSession(){return this.#begin('end-session',{});}
  // An account picked in a provider island: switches only to an app session this
  // document already holds for exactly (current issuer, subject). Never a flow.
  selectAccount(subject){
    const session=this.#client.session;
    if(!session||!this.#client.selectSession(session.issuer,subject))return {outcome:'canceled',code:'no-session'};
    this.#sync();return {outcome:'completed'};
  }
  // App sign-out only (decision D8): clears this app's sessions and pending
  // logins, optionally revoking each app session with its own token (RFC 7009).
  // Never ends provider sessions.
  async signOut({revoke=false}={}){
    this.cancelFlow();const held=this.#client.signOut();this.#sync();
    if(revoke)await Promise.all(held.map(session=>this.#client.revokeSession(session).catch(()=>false)));
    return {outcome:'completed'};
  }
  // Redirect-mode completion on the registered callback page.
  completeCallback(url=this.#window?.location?.href){
    let state=null;try{state=new URL(url).searchParams.get('state');}catch{}
    const pending=this.#client.readPending(state??undefined),intent=pending?.intent??'login';
    const flow=this.#newFlow(intent,{},'redirect');flow.phase='completing';flow.state=pending?.state;this.#emitState();
    return new Promise(resolve=>{flow.resolve=resolve;this.#complete(flow,url);});
  }
  // Island glue (components profile §8): inputs for `prepare`, and completion of a
  // `code` the island delivered on the port that received that `prepare`.
  prepareIsland(issuer){return this.#client.prepareIslandFlow(issuer,{requests:this.requests});}
  async completeIslandCode(message){
    try{await this.#client.completeCode(message,{presentation:'island'});this.#sync();return {outcome:'completed'};}
    catch(error){this.#sync();return error?.code==='canceled'?{outcome:'canceled'}:{outcome:'network-error',code:flowCodes.includes(error?.code)?error.code:'network-error'};}
  }
  cancelFlow(){
    const flow=this.#flow;if(!flow)return;
    if(flow.done){this.#flow=null;this.#emitState();return;}
    this.#cancelTransaction(flow);this.#closePopup(flow);this.#end(flow,{outcome:'dismissed'});
  }
  // "Continue in this tab": a fresh redirect entry and transaction (EE-17). A late
  // callback from the abandoned popup fails the single-use state check.
  continueInTab(){const flow=this.#flow;if(!flow)return Promise.resolve({outcome:'dismissed'});return this.#begin(flow.intent,flow.params,{forceRedirect:true});}
  // "Try again" after a blocked popup; must run in a new user activation.
  retry(){const flow=this.#flow;if(!flow)return Promise.resolve({outcome:'dismissed'});return this.#begin(flow.intent,flow.params);}
  // Best effort: after the COOP swap the handle may be dead and focus() does nothing.
  showWindow(){try{this.#flow?.popup?.focus();}catch{}}

  #cancelTransaction(flow){flow.controller?.abort();if(flow.state)this.#client.cancelLogin(flow.state);}
  #newFlow(intent,params,presentation){
    if(this.#flow&&!this.#flow.done){this.#cancelTransaction(this.#flow);this.#closePopup(this.#flow);this.#end(this.#flow,{outcome:'dismissed'});}
    const flow={intent,params,presentation,phase:'opening',host:null,lingering:false,fallback:false,done:false,popup:null,timers:[],controller:new AbortController()};
    this.#flow=flow;return flow;
  }
  // The issuer a flow targets, decided synchronously before any window opens.
  #target(intent,params){
    if(intent!=='login')return {issuer:this.#client.session.issuer};
    const host=params.identity!==undefined?parseIdentity(params.identity,this.defaultHost,{allowInsecureLocalhost:this.#client.allowInsecureLocalhost===true}).host:params.host??(['','none'].includes(this.defaultHost??'')?null:this.defaultHost);
    if(!host)return {code:'identity-required'};
    const scheme=/^localhost(?::\d+)?$/.test(host)&&this.#client.allowInsecureLocalhost===true?'http':'https';
    return {issuer:`${scheme}://${host}`};
  }
  #begin(intent,params,{forceRedirect=false,skipTransports=false,activationLost=false,continued=false}={}){
    if(intent!=='login'&&!this.#client.session)return Promise.resolve(this.#announce(intent,{outcome:'canceled',code:'no-session'}));
    // Parse before any window opens, so a typo never flashes a popup (EE-15).
    let target;try{target=this.#target(intent,params);}catch(error){return Promise.resolve(this.#announce(intent,{outcome:'discovery-error',code:'invalid-identity',message:error.message}));}
    if(target.code)return Promise.resolve(this.#announce(intent,{outcome:'discovery-error',code:target.code}));
    const capabilities=this.#client.capabilitiesFor(target.issuer);
    // Known capabilities gate intents before any window or request (no popup that then fails).
    if(capabilities&&intent!=='login'&&!capabilities.intents.includes(intent))return Promise.resolve(this.#announce(intent,{outcome:'discovery-error',code:'unsupported-provider'}));
    if(capabilities&&intent==='login'&&params.identity===undefined&&!capabilities.identityless)return Promise.resolve(this.#announce(intent,{outcome:'discovery-error',code:'identity-required'}));
    if(capabilities&&!this.#client.clientIdFor(target.issuer))return Promise.resolve(this.#announce(intent,{outcome:'discovery-error',code:'unregistered-client'}));
    // Transports get the first chance, synchronously inside the user activation:
    // the built-in FedCM transport when declared (presentation "auto"), then app
    // transports. A transport returns null when it does not apply, or a promise of
    // {outcome, code?}; {outcome:'unavailable'} falls back to popup or redirect.
    if(!forceRedirect&&!skipTransports){
      const builtIn=this.presentation==='auto'&&capabilities?.fedcm&&['login','select-account'].includes(intent)&&typeof this.#window?.navigator?.credentials?.get==='function'?[{name:'fedcm',available:()=>true,authorize:context=>fedcm().then(module=>module.authorizeWithFedCM({...context,navigator:this.#window.navigator,capabilities,failures:this.#fedcmFailures}))}]:[];
      for(const transport of [...builtIn,...this.transports??[]]){
        let attempt=null;
        const flow=this.#newFlow(intent,params,transport.name??'custom');
        try{attempt=transport?.available?.({intent,session:this})?transport.authorize({intent,params,session:this,client:this.#client,extensions:this.entryExtensions,requests:this.requests,uiLocales:this.uiLocales,colorScheme:this.#scheme(),signal:flow.controller.signal}):null;}catch{attempt=null;}
        if(!attempt){this.#flow=null;flow.done=true;continue;}
        this.#dispatch('flow-start',{intent,presentation:flow.presentation,source:'app'});this.#emitState();
        return new Promise(resolve=>{flow.resolve=resolve;Promise.resolve(attempt).then(result=>{
          if(flow.done)return;
          // Late failures may have outlived the click's activation; those continue as a redirect.
          if(result?.outcome==='unavailable'){this.#flow=null;flow.done=true;resolve(this.#begin(intent,params,{skipTransports:true,activationLost:true,continued:true}));return;}
          this.#sync();this.#end(flow,result&&flowOutcomes.includes(result.outcome)?result:{outcome:'network-error',code:'network-error'});
        },()=>{if(!flow.done){this.#sync();this.#end(flow,{outcome:'network-error',code:'network-error'});}});});
      }
    }
    // A popup only when the provider declares it (or, before discovery, when the
    // app explicitly asked for popups: then it is opened speculatively and closed
    // again if the declaration does not list `popup`).
    let presentation='redirect',popup=null,blocked=false;
    const wantsPopup=!forceRedirect&&this.presentation!=='redirect'&&this.popupAvailable&&(capabilities?capabilities.popup:this.presentation==='popup');
    if(wantsPopup){
      const activation=this.#window.navigator?.userActivation;
      if(activation&&!activation.isActive&&!activationLost)return Promise.reject(new DOMException('Popup sign-in must start from a user action.','NotAllowedError'));
      if(!activation||activation.isActive){
        // Synchronously, inside the activation. No position or size features, so the
        // embedder cannot place provider controls under the cursor (EE-04).
        if(this.#flow&&!this.#flow.done){this.#cancelTransaction(this.#flow);this.#closePopup(this.#flow);this.#end(this.#flow,{outcome:'dismissed'});}
        try{popup=this.#window.open('about:blank','_blank','popup');}catch{popup=null;}
        // Some blockers return an already-closed window instead of null.
        if(popup?.closed){try{popup.close();}catch{}popup=null;}
        if(popup){
          presentation='popup';
          try{popup.opener=null;}catch{}
          try{popup.document.title=this.#t('Sign in');popup.document.body.textContent=this.#t('Contacting your provider…');}catch{}
        } else blocked=true;
      }
    }
    const flow=this.#newFlow(intent,params,presentation);flow.popup=popup;flow.issuer=target.issuer;flow.speculative=!!popup&&!capabilities;
    if(blocked&&this.popupFallback!=='redirect'){
      flow.phase='blocked';if(!continued)this.#dispatch('flow-start',{intent,presentation:'popup',source:'app'});
      return Promise.resolve(this.#end(flow,{outcome:'popup-blocked',code:'popup-blocked'}));
    }
    // Provisional default: a blocked popup continues automatically as a redirect.
    flow.fallback=blocked;
    // A transport fallback continues the flow that already announced its start.
    if(!continued)this.#dispatch('flow-start',{intent,presentation,source:'app'});this.#emitState();
    return new Promise(resolve=>{flow.resolve=resolve;this.#run(flow);});
  }
  #announce(intent,result){this.#dispatch('flow-start',{intent,presentation:null,source:'app'});this.#dispatch('flow-end',{intent,...result});return result;}
  #scheme(){return this.colorScheme??(this.#window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches?'dark':'light');}
  async #run(flow){
    const client=this.#client,signal=flow.controller.signal;
    try{
      if(flow.speculative){
        const found=flow.params.identity!==undefined?await client.discover(flow.params.identity,{signal}):await client.discoverHost(new URL(flow.issuer).host,{signal});
        if(flow.done)return;
        if(found.kind==='email-fallback'){this.#closePopup(flow);return this.#end(flow,{outcome:'discovery-error',code:'no-provider',fallback:found});}
        if(!client.capabilitiesFor(flow.issuer)?.popup){this.#closePopup(flow);flow.popup=null;flow.presentation='redirect';this.#emitState();}
      }
      const begun=await client.beginAuthorization({intent:flow.intent,identity:flow.params.identity,host:flow.params.host,requests:this.requests,maxAge:flow.params.maxAge,uiLocales:this.uiLocales,colorScheme:this.#scheme(),presentation:flow.presentation,extensions:typeof this.entryExtensions==='function'?await this.entryExtensions({intent:flow.intent}):undefined,signal});
      if(flow.done){if(begun?.state)client.cancelLogin(begun.state);return;}
      if(begun.kind==='email-fallback'){this.#closePopup(flow);return this.#end(flow,{outcome:'discovery-error',code:'no-provider',fallback:begun});}
      flow.host=new URL(begun.issuer).host;flow.state=begun.state;
      if(flow.presentation==='redirect'){
        flow.phase='redirecting';this.#end(flow,{outcome:'redirecting',...flow.fallback?{fallback:true}:{}});
        this.#window.location.assign(begun.authorizationUrl);return;
      }
      const name=await callbackChannelName(begun.state,this.#crypto);
      if(flow.done)return;
      if(flow.popup.closed){client.cancelLogin(begun.state);return this.#end(flow,{outcome:'dismissed'});}
      // Listen only while this transaction is pending.
      flow.channel=new this.#channel(name);
      flow.channel.onmessage=event=>this.#relay(flow,event.data);
      try{flow.popup.location.href=begun.authorizationUrl;}catch{try{flow.popup.location=begun.authorizationUrl;}catch{}}
      flow.phase='waiting';this.#emitState();
      flow.timers.push(this.#timers.setTimeout(()=>{if(!flow.done){flow.lingering=true;this.#emitState();}},flowTimings.lingerAfter));
      flow.timers.push(this.#timers.setTimeout(()=>{if(!flow.done){client.cancelLogin(begun.state);this.#end(flow,{outcome:'dismissed'});}},flowTimings.entryLifetime));
      // Server runtimes (SSR, tests) must not be kept alive by an abandoned flow.
      for(const timer of flow.timers)timer?.unref?.();
    }catch(error){
      if(flow.done)return;
      this.#closePopup(flow);
      const code=error?.code??(error?.name==='AbortError'?'canceled':'network-error');
      this.#end(flow,code==='canceled'?{outcome:'canceled'}:{outcome:discoveryCodes.has(code)?'discovery-error':'network-error',code:discoveryCodes.has(code)||flowCodes.includes(code)?code:'network-error'});
    }
  }
  #relay(flow,data){
    const message=parseRelayMessage(data);
    if(!message||flow.done||flow.phase!=='waiting'||message.state!==flow.state)return;
    // Acknowledge, so the callback page can tell the user whether to close it.
    try{flow.channel?.postMessage({v:1,type:'bindle-callback-ack',state:message.state});}catch{}
    flow.phase='completing';flow.channel?.close();flow.channel=null;this.#emitState();
    this.#complete(flow,relayCallbackUrl(this.#client.redirectUri,message));
  }
  async #complete(flow,url){
    const client=this.#client,previous=client.session;
    try{
      if(flow.intent==='end-session'){const {result}=await client.completeEndSession(url);this.#sync();return this.#end(flow,{outcome:result==='completed'?'completed':'canceled'});}
      await client.completeLogin(url);
      // Revoking a same-account grant could also revoke the new tokens (RFC 7009 may revoke the whole grant).
      const current=client.session;
      if((flow.intent==='select-account'||flow.params.switching)&&flow.params.revokePrevious&&previous&&current&&(previous.subject!==current.subject||previous.issuer!==current.issuer)){client.forgetSession(previous);client.revokeSession(previous).catch(()=>{});}
      this.#sync();this.#end(flow,{outcome:'completed'});
    }catch(error){
      this.#sync();
      const code=error?.code;
      this.#end(flow,code==='canceled'?{outcome:'canceled'}:{outcome:'network-error',code:code&&flowCodes.includes(code)?code:'network-error'});
    }
  }
  #end(flow,result){
    if(flow.done)return result;
    flow.done=true;flow.result=result;
    // Terminal outcomes never leave a redeemable verifier behind.
    if(!['redirecting','popup-blocked'].includes(result.outcome)&&flow.state)this.#client.cancelLogin(flow.state);
    // Provider end-session always clears app tokens once the flow finishes, whatever the result.
    if(flow.intent==='end-session'&&!['redirecting','popup-blocked'].includes(result.outcome)&&this.#client.session){this.#client.signOut();this.#sync();}
    for(const timer of flow.timers)this.#timers.clearTimeout(timer);
    flow.channel?.close();flow.channel=null;flow.controller.abort();
    if(this.#flow===flow&&!['popup-blocked','redirecting'].includes(result.outcome))this.#flow=null;
    this.#dispatch('flow-end',{intent:flow.intent,...result});this.#emitState();
    flow.resolve?.(result);
    return result;
  }
  #closePopup(flow){try{flow.popup?.close();}catch{}}
  #emitState(){this.#dispatch('flow-state',this.flow);}
  #dispatch(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}
  // Re-reads the client so direct client calls (completeLogin, signOut) are reflected.
  #sync(emit=true){
    const session=this.#client.session;
    if(session!==this.#watched){this.#watched=session;this.#scheduleExpiry();}
    const view=freezeView(session),key=viewKey(view);
    if(key===this.#viewKey)return;
    this.#view=view;this.#viewKey=key;
    if(emit){this.#capabilitiesChanged();this.#dispatch('change',view);}
  }
  refresh(){this.#sync();}
  #scheduleExpiry(){
    if(this.#expiry!==null)this.#timers.clearTimeout(this.#expiry);this.#expiry=null;
    const session=this.#client.session;if(!session)return;
    const deadline=session.refresh_token?session.refreshExpiresAt:session.expiresAt,clock=this.#client.clock??Date.now;
    if(!Number.isFinite(deadline))return;
    this.#expiry=this.#timers.setTimeout(()=>{
      this.#expiry=null;const current=this.#client.session;
      if(!current)return this.#sync();
      const end=current.refresh_token?current.refreshExpiresAt:current.expiresAt;
      if(clock()>=end){this.#client.forgetSession(current);this.#sync();}else{this.#watched=null;this.#sync();}
    },Math.max(0,Math.min(deadline-clock(),2147483647)));
    this.#expiry?.unref?.();
  }
  dispose(){this.cancelFlow();this.#unsubscribe?.();if(this.#expiry!==null)this.#timers.clearTimeout(this.#expiry);this.#expiry=null;}
}

export function createSession(options){return new BindleSession(options);}

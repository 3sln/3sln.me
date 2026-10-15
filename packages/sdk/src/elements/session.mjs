// <bindle-session>: the non-visual controller (design §3.1). Owns one
// BindleClient and one flow at a time; descendants find it through the context
// protocol, or link explicitly with controller="<id>". It works with any Bindle
// provider and exposes the frozen capability set descendants compose from.
// The headless controller (flows, client, capabilities) loads on connect, in
// parallel with the first render, so define.mjs stays within its budget; flows
// requested before it is ready wait for it.
import {ElementBase,emit,localize,sessionContext,startFlow} from './shared.mjs';

const presentations=['auto','popup','redirect'];

const forwarded=[['change','bindle-session-change'],['flow-start','bindle-flow-start'],['flow-end','bindle-flow-end'],['flow-state','bindle-flow-state'],['capabilities-change','bindle-capabilities-change']];
const listOf=value=>value?value.split(/\s+/).filter(Boolean):null;

export class BindleSessionElement extends ElementBase {
  static observedAttributes=['presentation','popup-fallback','default-host','theme','lang','islands','island-issuers'];
  #client=null;#clientIds;#transports=[];#entryExtensions;#controller=null;#requests;#ready;#resolveReady;#initiator=null;#disposeTimer=null;#loading=null;#settled=false;
  constructor(){
    super();
    this.#ready=new Promise(resolve=>this.#resolveReady=resolve);
    this.addEventListener('context-request',event=>{
      if(event.context!==sessionContext||typeof event.callback!=='function')return;
      event.stopPropagation();event.callback(this);
    });
  }
  get client(){return this.#controller?.client??this.#client;}
  set client(value){if(this.#controller)throw new Error('Assign client before the element connects.');this.#client=value;}
  // Per-provider client IDs: a map {issuerOrigin: id} or a resolver (issuer) => id|null.
  get clientIds(){return this.#clientIds;}
  set clientIds(value){if(this.#controller)throw new Error('Assign clientIds before the element connects.');this.#clientIds=value;}
  // Strategy hooks for app transports and entry extensions. Assign before the element connects.
  get transports(){return this.#transports;}
  set transports(value){if(this.#controller)throw new Error('Assign transports before the element connects.');this.#transports=Array.isArray(value)?value:[];}
  get entryExtensions(){return this.#entryExtensions;}
  set entryExtensions(value){if(this.#controller)throw new Error('Assign entryExtensions before the element connects.');this.#entryExtensions=value;}
  get controller(){return this.#controller;}
  get ready(){return this.#ready;}
  get requests(){return this.#controller?.requests??this.#requests??[];}
  set requests(value){this.#requests=Array.isArray(value)?value:[];if(this.#controller)this.#controller.requests=this.#requests;}
  get session(){return this.#controller?.session??null;}
  get state(){return this.#controller?.state??'signed-out';}
  get flow(){return this.#controller?.flow??null;}
  get flowInitiator(){return this.#initiator;}
  // Frozen capability set of the current session's issuer (or the default provider when signed out); null before discovery.
  get capabilities(){return this.#controller?.capabilities??null;}
  get presentation(){const value=this.getAttribute('presentation');return presentations.includes(value)?value:'auto';}
  set presentation(value){this.setAttribute('presentation',value);}
  // default-host="none" disables handle completion: only complete handles are accepted.
  get defaultHost(){return this.getAttribute('default-host')||this.#controller?.defaultHost||'3sln.me';}
  set defaultHost(value){if(value)this.setAttribute('default-host',value);else this.removeAttribute('default-host');}
  #islandPolicy(){return {islands:this.getAttribute('islands')==='off'?'off':'auto',issuers:listOf(this.getAttribute('island-issuers'))};}

  connectedCallback(){
    if(this.#disposeTimer!==null){clearTimeout(this.#disposeTimer);this.#disposeTimer=null;}
    this.#loading??=Promise.all([import('../identity.mjs'),import('../flows.mjs')]).then(modules=>{this.#settled=true;this.#start(...modules);},error=>{this.#settled=true;emit(this,'bindle-error',{code:'configuration',message:error?.message??'The Bindle controller could not load.'});this.#resolveReady(this);});
  }
  #start({BindleClient},{createSession}){
    const {t,locale}=localize(this);
    let client=this.#client;
    try{
      client??=new BindleClient({clientId:this.#clientIds??this.getAttribute('client-id')??undefined,clientMetadataUrl:this.getAttribute('client-metadata')??undefined,redirectUri:this.getAttribute('redirect-uri'),defaultHost:this.defaultHost,emailFallback:this.getAttribute('email-fallback')!=='off'});
    }catch(error){
      emit(this,'bindle-error',{code:'configuration',message:error.message});
      this.#resolveReady(this);return;
    }
    const policy=this.#islandPolicy();
    this.#controller=createSession({client,presentation:this.presentation,popupFallback:this.getAttribute('popup-fallback')==='prompt'?'prompt':'redirect',requests:this.#requests??this.#readRequests(),uiLocales:[locale],colorScheme:this.#colorScheme(),localize:t,transports:this.#transports,entryExtensions:this.#entryExtensions,islands:policy.islands,islandIssuers:policy.issuers});
    // An explicitly assigned client keeps its own default host unless the attribute is set.
    if(this.hasAttribute('default-host'))this.#controller.defaultHost=this.defaultHost;
    for(const [from,to] of forwarded)this.#controller.addEventListener(from,event=>{
      if(from==='flow-end'&&!['popup-blocked','redirecting'].includes(event.detail.outcome))queueMicrotask(()=>{if(!this.#controller.flow)this.#initiator=null;});
      // A change of the capability issuer (sign-in at another provider) fetches its declaration.
      if(from==='change')this.#controller.loadCapabilities();
      emit(this,to,event.detail);
    });
    // Initial state, so late listeners can read session or await ready (EE-13).
    emit(this,'bindle-session-change',this.#controller.session);
    this.#resolveReady(this);
    this.#controller.loadCapabilities();
    this.#maybeHandleCallback();
    if(!this.isConnected)this.disconnectedCallback();
  }
  disconnectedCallback(){
    // Moving the element within the document must not cancel a flow.
    this.#disposeTimer=setTimeout(()=>{this.#disposeTimer=null;if(!this.isConnected){this.#controller?.dispose();}},0);
  }
  attributeChangedCallback(name){
    const controller=this.#controller;if(!controller)return;
    if(name==='presentation')controller.presentation=this.presentation;
    if(name==='popup-fallback')controller.popupFallback=this.getAttribute('popup-fallback')==='prompt'?'prompt':'redirect';
    if(name==='default-host'){controller.defaultHost=this.defaultHost;controller.loadCapabilities();}
    if(name==='theme')controller.colorScheme=this.#colorScheme();
    if(name==='lang')controller.uiLocales=[localize(this).locale];
    if(name==='islands'||name==='island-issuers')controller.islandPolicy=this.#islandPolicy();
  }
  #colorScheme(){const theme=this.getAttribute('theme');return ['light','dark'].includes(theme)?theme:undefined;}
  #readRequests(){
    const id=this.getAttribute('requests-src');if(!id)return [];
    try{const value=JSON.parse((this.getRootNode().getElementById?.(id)??document.getElementById(id))?.textContent??'[]');return Array.isArray(value)?value:[];}
    catch{emit(this,'bindle-error',{code:'configuration',message:'requests-src must reference a JSON array.'});return [];}
  }
  async #maybeHandleCallback(){
    const location=globalThis.location;if(!location||this.hasAttribute('no-callback'))return;
    let here,callback;try{here=new URL(location.href);callback=new URL(this.client.redirectUri);}catch{return;}
    if(here.origin!==callback.origin||here.pathname!==callback.pathname||!here.searchParams.has('state'))return;
    // The callback handler loads only on the callback page.
    const {handleCallback}=await import('../callback.mjs');
    await handleCallback({session:this.#controller});
  }
  [startFlow](intent,options,initiator){
    const controller=this.#controller;
    // Still loading: run once ready (the click's activation normally outlives the wait).
    if(!controller&&this.#loading&&!this.#settled)return this.#loading.then(()=>this[startFlow](intent,options,initiator));
    if(!controller){emit(this,'bindle-flow-end',{intent,outcome:'canceled',code:'not-configured'});return Promise.resolve({outcome:'canceled',code:'not-configured'});}
    this.#initiator=initiator??null;
    const run={login:()=>controller.signIn(options),'select-account':()=>controller.switchAccount(options),reauthenticate:()=>controller.reauthenticate(options),'end-session':()=>controller.endProviderSession()}[intent];
    return run();
  }
  signIn(options={}){return this[startFlow]('login',options);}
  switchAccount(options={}){return this[startFlow]('select-account',options);}
  reauthenticate(options={}){return this[startFlow]('reauthenticate',options);}
  endProviderSession(){return this[startFlow]('end-session',{});}
  signOut(options={}){return this.#controller?this.#controller.signOut(options):Promise.resolve({outcome:'completed'});}
  completeCallback(url){return this.#controller?this.#controller.completeCallback(url):Promise.resolve({outcome:'canceled',code:'not-configured'});}
  cancelFlow(){this.#controller?.cancelFlow();}
  continueInTab(){return this.#controller?.continueInTab();}
  retry(){return this.#controller?.retry();}
  showWindow(){this.#controller?.showWindow();}
}

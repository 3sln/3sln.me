// IA-4. Registered by the standard elements entry; inert until explicitly enabled.
// Assign config={INCREMENTAL_AUTH_ENABLED:true} and request={requests:[…]} or {target,…}; no HTML JSON parsing.
import {ElementBase,h,reconcileShadow,requestSession,emitLater,localeFor,schemeFor,watchScheme,baseStyles} from './shared.mjs';
import {css} from '../../../../vendor/dodo/style.js';
import {requestText,requestIslandSpec} from './request-protocol.mjs';
const styles=view=>css.in(view)`:host{display:block}.island{min-inline-size:0;inline-size:100%}.island[hidden]{display:none}.root{max-inline-size:100%}button{max-inline-size:100%;white-space:normal;overflow-wrap:anywhere}`;
export class BindleRequestElement extends ElementBase{
 static observedAttributes=['kind','lang','theme','disabled','island-variant'];
 #ops=null;#config={};#request={};#session=null;#engine=null;#transport=null;#island=null;#subscription=null;#stopScheme=null;#connected=false;#generation=0;#ready=null;#islandState='off';#fallback=false;#state={busy:false,held:false,outcome:null,result:null};#subject=null;#heldSubject=null;
 get config(){return this.#config;}set config(value){this.#config=value??{};if(this.#connected)this.#connect();}
 get request(){return this.#request;}set request(value){this.#request=structuredClone(value??{});if(this.#connected)this.#connect();}
 get kind(){return this.getAttribute('kind')==='configure'?'configure':'grant-more';}
 get result(){return this.#state.result;}
 get ready(){return Promise.resolve().then(()=>this.#ready??this);}
 connectedCallback(){this.#connected=true;this.#stopScheme=watchScheme(this,()=>this.render());this.render();requestSession(this,session=>{if(!this.#connected)return;this.#session=session;session.addEventListener('bindle-session-change',this.#changed);this.#connect();});}
 disconnectedCallback(){this.#connected=false;this.#generation++;this.#session?.removeEventListener('bindle-session-change',this.#changed);this.#stopScheme?.();this.#destroy();}
 attributeChangedCallback(name){if(!this.#connected)return;if(name==='kind'||name==='disabled')this.#connect();else this.render();}
 #changed=()=>{const subject=this.#session?.session?.subject;if(subject!==this.#subject)this.#connect();};
 #destroy(){this.#island?.destroy();this.#island=null;this.#subscription?.unsubscribe();this.#subscription=null;const engine=this.#engine,transport=this.#transport,ops=this.#ops;if(engine)ops.performRequest(engine,new ops.CancelRequest()).finally(async()=>{await engine.dispose();await transport?.dispose();}).catch(()=>{});else transport?.dispose();this.#engine=null;this.#transport=null;this.#islandState='off';}
 #connect(){
  const generation=++this.#generation;this.#destroy();this.#fallback=false;this.#state={busy:false,held:false,outcome:null,result:null};this.#subject=this.#session?.session?.subject;
  if(this.#heldSubject&&this.#subject!==this.#heldSubject)this.#heldSubject=null;
  if(!this.#connected||!this.#subject||this.hasAttribute('disabled')||this.#heldSubject===this.#subject||!(this.#config.INCREMENTAL_AUTH_ENABLED===true||this.#config.INCREMENTAL_AUTH_ENABLED==='true')){this.render();return;}
  this.#ready=(async()=>{
   const [ops,{createIncrementalEngine,BeginIncrementalAuthorization,CompleteIncrementalAuthorization,CancelIncrementalAuthorization}]=await Promise.all([import('./request-engine.mjs'),import('../incremental.mjs')]);
   const {createRequestEngine,performRequest,PrepareRequest,RequestFlow,ReceiveRequestCode,RequestState}=ops;this.#ops=ops;
   if(generation!==this.#generation)return this;
   const session=this.#session,client=session.client,issuer=session.session.issuer,incremental=createIncrementalEngine({client,enabled:true}),kind=this.kind,request=structuredClone(this.#request),options=()=>({intent:kind,request,uiLocales:[localeFor(this)],colorScheme:['light','dark'].includes(schemeFor(this,session).theme)?schemeFor(this,session).theme:undefined});
   const transport={
    prepare:()=>performRequest(incremental,new BeginIncrementalAuthorization({...options(),presentation:'popup',prepareOnly:true})),
    cancel:state=>performRequest(incremental,new CancelIncrementalAuthorization(state?{state}:{})),
    complete:async({prepare,code})=>{const u=new URL(client.redirectUri);u.searchParams.set('state',prepare.state);u.searchParams.set('iss',issuer);u.searchParams.set(kind==='configure'?'result':'code',kind==='configure'?'unchanged':code?.code??'');const result=await performRequest(incremental,new CompleteIncrementalAuthorization({url:u.href}));return kind==='configure'?Object.freeze({...result,outcome:'completed'}):result;},
    redirect:async()=>{const begun=await performRequest(incremental,new BeginIncrementalAuthorization({...options(),presentation:'redirect'}));if(generation!==this.#generation){await transport.cancel(begun.state);return {outcome:'canceled'};}this.ownerDocument.defaultView.location.assign(begun.authorizationUrl);return {outcome:'redirecting'};},
    dispose:()=>incremental.dispose(),
   };
   this.#transport=transport;this.#engine=createRequestEngine({config:this.#config,origin:new URL(client.redirectUri).origin,issuer,transport});
   this.#subscription=this.#engine.query(new RequestState()).subscribe({next:state=>{if(generation!==this.#generation)return;this.#state=state;if(state.held)this.#heldSubject=this.#subject;this.render();}});
   const policy={islands:session.getAttribute('islands')==='off'?'off':'auto',islandIssuers:session.hasAttribute('island-issuers')?session.getAttribute('island-issuers').split(/\s+/).filter(Boolean):null},spec=requestIslandSpec(client,kind,policy);
   if(spec){const {mountRequestIsland}=await import('./request-island.mjs');if(generation!==this.#generation)return this;const engine=this.#engine;this.#island=mountRequestIsland({element:this,container:this.shadowRoot.querySelector('.island-host'),session,spec,prepare:()=>generation===this.#generation?performRequest(engine,new PrepareRequest({kind})):null,onCode:code=>generation===this.#generation?performRequest(engine,new ReceiveRequestCode(code)):null,onFlow:async(phase,outcome)=>{if(generation!==this.#generation)return;const result=await performRequest(engine,new RequestFlow({phase,outcome}));if(result&&generation===this.#generation)this.#event(result);},onState:state=>{if(generation!==this.#generation)return;this.#islandState=state;if(state==='fallback')this.#fallback=true;this.render();}});}
   this.render();return this;
  })().catch(()=>{if(generation===this.#generation){this.#state.outcome='unavailable';this.render();}return this;});
 }
 #event(result){if(result.phase==='ended'&&['popup-blocked','unavailable'].includes(result.outcome))this.#fallback=true;emitLater(this,result.phase==='started'?'bindle-request-start':'bindle-request-end',result.phase==='started'?{}:{outcome:result.outcome});this.render();}
 #activate=event=>{
  const win=this.ownerDocument.defaultView;if(!event.isTrusted||win.navigator.userActivation?.isActive!==true||!this.#engine||this.#state.busy||this.#state.held||!(this.#config.INCREMENTAL_AUTH_ENABLED===true||this.#config.INCREMENTAL_AUTH_ENABLED==='true'))return;
  emitLater(this,'bindle-request-start',{});this.#ops.performRequest(this.#engine,new this.#ops.RedirectRequest({kind:this.kind,activation:true})).then(result=>{if(result)this.#event(result);});
 };
 render(){
  if(!this.#connected)return;const text=requestText(localeFor(this)),{theme}=schemeFor(this,this.#session),live=this.#islandState==='live',disabled=this.hasAttribute('disabled')||!this.#engine||this.#state.busy||this.#state.held;
  const status=this.#state.busy?text.busy:({completed:text.finished,canceled:text.canceled,declined:text.declined,unchanged:text.unchanged,'popup-blocked':text.blocked,unavailable:text.unavailable})[this.#state.outcome]??'';
  reconcileShadow(this,[h('div',h('div',h('div').classes('island-host')).classes('island').props({hidden:!live}).key('island'),(!live||this.#fallback)&&h('button',this.#fallback?text.continue.replace('{host}',this.#session?.session?.issuer?new URL(this.#session.session.issuer).host:''):text[this.kind==='configure'?'settings':'access']).props({type:'button',disabled}).attrs({part:'request','aria-busy':this.#state.busy?'true':'false'}).on({click:this.#activate}),h('p',status).classes('status').attrs({role:'status','aria-live':'polite',part:'status'})).classes('root',theme)],[baseStyles(this.ownerDocument.defaultView),styles(this.ownerDocument.defaultView)]);
  this.#island?.refresh();
 }
}
export function defineBindleRequestElement({registry=globalThis.customElements,name='bindle-request'}={}){if(!registry||registry.get(name))return false;registry.define(name,name==='bindle-request'?BindleRequestElement:class extends BindleRequestElement{});return true;}

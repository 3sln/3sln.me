// <bindle-sign-in>: sign-in for any Bindle provider (decision note §6.1). It
// composes from the default provider's capability set: a provider island when
// declared and mounted; otherwise a "Continue with {host}" button when the
// provider allows identity-optional sign-in, plus the handle form (then optional);
// otherwise the handle form with a complete handle required. One event API in
// every composition. Everything typed here is readable by the embedder; nothing
// here learns anything about provider sessions. Security copy is not slottable.
import {parseIdentity} from '../handle.mjs';
import {ElementBase,attrs,baseStyles,emit,emitLater,failureText,flowNotice,flowStatus,h,localize,mountIsland,islandPart,reconcileShadow,requestSession,schemeFor,startFlow,watchScheme} from './shared.mjs';
import {css} from '../../../../vendor/dodo/style.js';

const styles=view=>css.in(view)`
form{display:block}
label{display:block;font-weight:600;margin-block-end:.5em}
.identity{display:flex;align-items:center;flex-wrap:wrap;gap:.25em;border:1px solid var(--_border);border-radius:var(--_radius);padding:.6em .8em;background:var(--_surface);color:var(--_text)}
.identity:focus-within{outline:3px solid var(--_focus);outline-offset:2px}
input{min-inline-size:6em;border:0;outline:none;flex:1;font:inherit;background:transparent;color:inherit;min-block-size:32px}
.suffix{color:var(--_muted)}
.help{font-size:.9em;color:var(--bindle-text-muted,color-mix(in srgb,currentColor 78%,transparent));margin:.5em 0 0}
.submit{margin-block-start:1em}
.continue{display:block;inline-size:100%;margin-block-end:1em}
.island{display:block;min-block-size:44px}
.island:empty,.island[hidden]{display:none}
@media (forced-colors:active){.identity{border-color:FieldText;background:Field;color:FieldText}}
`;
const endOutcomes={completed:'completed',canceled:'canceled',dismissed:'canceled','popup-blocked':'popup-blocked','discovery-error':'discovery-error','network-error':'network-error'};

export class BindleSignInElement extends ElementBase {
  static observedAttributes=['lang','theme','default-host','identity-required'];
  #session=null;#value='';#status='';#error='';#listeners=[];#connected=false;#unwatch=null;#island=null;#islandState='off';#islandKey='';#form=false;#last=null;#started=false;#discovering=null;
  connectedCallback(){
    this.#connected=true;this.#unwatch=watchScheme(this,()=>this.render());
    this.render();
    requestSession(this,session=>{if(!this.#connected)return;this.#attach(session);});
  }
  disconnectedCallback(){this.#connected=false;this.#unwatch?.();this.#detach();this.#unmount();}
  attributeChangedCallback(){if(this.#connected)this.render();}
  get session(){return this.#session;}
  get defaultHost(){return this.getAttribute('default-host')||this.#session?.defaultHost||'3sln.me';}
  set defaultHost(value){if(value)this.setAttribute('default-host',value);else this.removeAttribute('default-host');}
  // Read-only snapshot, updated before the corresponding event (late listeners read it).
  get state(){return Object.freeze({status:this.#mine()&&this.#session?.flow&&!this.#session.flow.done?'pending':'idle',islands:this.#islandState,last:this.#last});}
  // Re-evaluates the effective scheme after an embedder theme change the element cannot observe.
  refreshTheme(){if(this.isConnected)this.render();}
  focus(options){this.shadowRoot?.querySelector('input')?.focus(options);}
  #mine(){return !!this.#session&&this.#session.flowInitiator===this;}
  #attach(session){
    this.#detach();this.#session=session;
    const rerender=()=>this.render();
    const started=event=>{if(this.#mine()&&!this.#started){this.#started=true;emitLater(this,'bindle-sign-in-start',{source:'form',presentation:event.detail?.presentation??null});}};
    const ended=event=>{
      if(!this.#mine())return;
      const result=event.detail;
      if(['discovery-error','network-error'].includes(result.outcome)){this.#error=failureText({...result,host:this.#hostFor(result)},this.#t());this.#status='';if(result.code==='no-provider'&&result.fallback)emit(this,'bindle-email-fallback',result.fallback);}
      else if(result.outcome==='canceled'){this.#status=this.#t()('Sign-in was canceled.');}
      else if(result.outcome==='completed'||result.outcome==='dismissed')this.#status='';
      // One end per start; a redirect continues on the callback page instead.
      const outcome=endOutcomes[result.outcome];
      if(outcome&&this.#started){this.#started=false;this.#last=Object.freeze({outcome,...result.code?{code:result.code}:{}});const view=session.session;emitLater(this,'bindle-sign-in-end',{outcome,...result.code?{code:result.code}:{},...outcome==='completed'&&view?{session:view}:{}});}
      this.render();
    };
    for(const [type,listener] of [['bindle-flow-state',rerender],['bindle-flow-start',started],['bindle-flow-end',ended],['bindle-session-change',rerender],['bindle-capabilities-change',rerender]]){session.addEventListener(type,listener);this.#listeners.push([type,listener]);}
    this.render();
  }
  #detach(){for(const [type,listener] of this.#listeners)this.#session?.removeEventListener(type,listener);this.#listeners=[];}
  #t(){return localize(this).t;}
  #hostFor(result){try{return result.code==='unregistered-client'?parseIdentity(this.#value.trim()||'x',this.defaultHost).host:undefined;}catch{return undefined;}}
  #onInput=event=>{this.#value=event.target.value;this.#error='';this.render();};
  #onSubmit=event=>{
    event.preventDefault();
    const t=this.#t(),input=this.shadowRoot.querySelector('input'),value=input.value;this.#value=value;
    if(this.#session)return this.#submit(value.trim(),t,input);
    // Without a <bindle-session> the element only reports the parsed handle.
    try{const identity=parseIdentity(value,this.defaultHost);this.#status='';this.#error='';emit(this,'bindle-login-request',identity);}
    catch(error){this.#status=t(error.message);this.render();input.focus();}
  };
  // Capabilities of the provider this element names (its own default host), never another issuer's.
  #capabilities(){
    const session=this.#session,host=this.defaultHost;if(!session?.controller||['','none'].includes(host))return null;
    let issuer;try{issuer=new URL(parseIdentity('x',host,{allowInsecureLocalhost:session.client?.allowInsecureLocalhost===true}).manifestUrl).origin;}catch{return null;}
    const capabilities=session.controller.capabilitiesFor(issuer);
    if(!capabilities&&this.#discovering!==issuer){this.#discovering=issuer;session.client.discoverHost(host).then(()=>this.render(),()=>{});}
    return capabilities;
  }
  #required(){
    const capabilities=this.#capabilities();
    return this.hasAttribute('identity-required')||['','none'].includes(this.defaultHost)||!!capabilities&&!capabilities.identityless||!this.#session;
  }
  #submit(trimmed,t,input){
    this.#error='';this.#status='';
    if(!trimmed&&this.#required()){this.#error=t('Enter your Bindle identity.');this.render();input?.focus();return;}
    let host=this.defaultHost,identity;
    // Parse synchronously before any window opens (EE-15); the flow receives the
    // complete handle (or this element's host), so it goes where the UI says.
    if(trimmed){try{({host,handle:identity}=parseIdentity(trimmed,this.defaultHost,{allowInsecureLocalhost:this.#session.client?.allowInsecureLocalhost===true}));}catch(error){this.#error=t(error.message);this.render();input?.focus();return;}}
    this.#status=t("You'll continue at {host}.",{host});this.#started=false;this.render();
    const options=identity?{identity}:{host};
    const started=this.#session[startFlow]?this.#session[startFlow]('login',options,this):this.#session.signIn(options);
    started.catch(error=>{this.#error=error?.name==='NotAllowedError'?t('Sign-in could not be completed. Try again.'):failureText(error,t);this.#status='';this.render();});
  }
  #onContinue=()=>this.#submit('',this.#t(),null);
  // Island hook (decision note §6.1): mounts only when the capability set lists the part.
  #syncIsland(){
    const capabilities=this.#capabilities(),spec=islandPart(this.#session,'sign-in',capabilities),key=spec?`${spec.issuer} ${spec.version}`:'';
    if(key===this.#islandKey)return;this.#islandKey=key;this.#unmount();
    if(!spec)return;
    queueMicrotask(async()=>{
      const container=this.shadowRoot?.querySelector('.island');if(!container||this.#islandKey!==key)return;
      this.#island=await mountIsland(this,{part:'sign-in',container,session:this.#session,capabilities,onState:state=>{this.#islandState=state;this.render();}});
      if(!this.#island&&this.#islandKey===key)this.#islandState='off';
    });
  }
  #unmount(){try{this.#island?.destroy?.();}catch{}this.#island=null;this.#islandState='off';}
  // Called by the island mounter when the island reports a flow (profile §5.4).
  islandFlow(phase,outcome){
    if(phase==='started'){this.#started=true;emitLater(this,'bindle-sign-in-start',{source:'island',presentation:'island'});return;}
    if(phase==='ended'&&this.#started&&outcome!=='completed'){this.#started=false;const mapped=outcome==='unavailable'?'unavailable':endOutcomes[outcome]??'canceled';this.#last=Object.freeze({outcome:mapped});emitLater(this,'bindle-sign-in-end',{outcome:mapped});}
  }
  render(){
    if(!this.#connected)return;
    const t=this.#t(),session=this.#session,flow=session?.flow,mine=this.#mine(),host=this.defaultHost,noDefault=['','none'].includes(host),suffix=noDefault?'':`@${host}`;
    const capabilities=this.#capabilities(),required=this.#required(),island=this.#islandState==='live';
    const identityless=!!capabilities?.identityless&&!noDefault;
    const status=(mine&&flow?.phase==='opening'&&this.#status)||(mine&&flowStatus(flow,t))||this.#status;
    const busy=mine&&flow?.phase==='opening';
    // With a live island the handle form moves behind "Use a different provider".
    const showForm=!island||this.#form;
    this.#syncIsland();
    const {theme,colorScheme}=schemeFor(this,session);
    reconcileShadow(this,[h('div',
      h('slot').attrs({name:'heading'}),
      h('div').classes('island').attrs({part:'island'}).props({hidden:!island}),
      island&&!this.#form&&h('button',t('Use a different provider')).props({type:'button'}).attrs({part:'other-provider'}).on({click:()=>{this.#form=true;this.render();this.focus();}}),
      !island&&identityless&&h('button',t('Continue with {host}',{host})).props({type:'button',disabled:busy}).classes('primary','continue').attrs({part:'continue'}).on({click:this.#onContinue}),
      showForm&&h('form',
        h('label',t('Your Bindle identity')).attrs({for:'handle',id:'label',part:'label'}),
        h('div',
          h('input').props({id:'handle',disabled:busy}).attrs(attrs({name:'identity',autocomplete:'username',autocapitalize:'none',spellcheck:'false',inputmode:'email',required,'aria-describedby':suffix?'suffix-hint help':'help','aria-invalid':this.#error?'true':undefined,'aria-errormessage':this.#error?'error':undefined,part:'input'})).on({input:this.#onInput}),
          suffix&&h('span',suffix).props({id:'suffix',hidden:this.#value.includes('@')}).attrs({'aria-hidden':'true',part:'suffix'}).classes('suffix'),
        ).classes('identity').attrs({part:'field'}),
        suffix&&h('span',t('{suffix} will be added unless you type @',{suffix})).props({id:'suffix-hint'}).classes('visually-hidden'),
        h('p',h('slot',t('Use your handle, or enter a full identity from your own provider.')).attrs({name:'help'})).props({id:'help'}).classes('help'),
        h('button',t('Continue')).props({disabled:busy}).attrs({type:'submit',part:'submit'}).classes(identityless?'':'primary','submit'),
        h('slot').attrs({name:'footer'}),
      ).attrs({part:'form',novalidate:''}).on({submit:this.#onSubmit}),
      h('p',status).props({id:'status'}).attrs({role:'status',part:'status'}).classes('status'),
      h('p',this.#error).props({id:'error'}).attrs({role:'alert',part:'error'}).classes('error'),
      mine&&flowNotice(flow,t,session),
    ).classes('root',theme).attrs({dir:localize(this).direction}).style(colorScheme?{'color-scheme':colorScheme}:{})],[baseStyles(this.ownerDocument.defaultView),styles(this.ownerDocument.defaultView)]);
  }
}

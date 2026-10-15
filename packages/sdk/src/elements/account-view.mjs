// AccountView: the implementation behind <bindle-account> (account.mjs), loaded
// when the element connects so define.mjs stays small. The composed profile
// button (decision note §6.2, CP-8). One
// <dialog> container (an anchored popover; disclosure pattern, no role=menu) in
// every composition. The trigger shows only approved, app-granted identity: the
// standard avatar (granted picture → initials → subject monogram) and the granted
// display name or handle. It never shows the handle typed into <bindle-sign-in>.
// Actions come from the session issuer's capability set, so nothing renders that
// the provider cannot do. Provider islands (avatar, switcher) mount through the
// island hook when declared; the standard composition is used otherwise.
import {parseIdentity} from '../handle.mjs';
import {attrs,baseStyles,emit,emitLater,flowNotice,flowStatus,h,islandPart,localize,mountIsland,reconcileShadow,requestSession,schemeFor,startFlow,watchScheme} from './shared.mjs';
import {avatarModel,avatarStyles,avatarView} from './avatar-view.mjs';
import {css} from '../../../../vendor/dodo/style.js';
import {accountActions} from './account.mjs';
const defaultActions=['switch','provider','sign-out','manage'];
const styles=view=>css.in(view)`
.wrap{position:relative;display:inline-block;max-inline-size:100%}
.trigger{color:var(--_text);display:inline-flex;align-items:center;gap:.5em;padding-block:.3em;padding-inline:.3em .9em;border-radius:999px;max-inline-size:100%;text-align:start}
.trigger.avatar-only{padding-inline:.3em}
.avatar-box{position:relative;display:inline-grid;flex:none}
.avatar-island{position:absolute;inset-block-start:.3em;inset-inline-start:.3em;inline-size:var(--bindle-avatar-size,32px);block-size:var(--bindle-avatar-size,32px);pointer-events:none}
.avatar-island[hidden],.wrap[hidden]{display:none}
.island-host{display:block;inline-size:100%;block-size:100%}
.label{overflow-wrap:anywhere}
.panel{box-sizing:border-box;min-inline-size:16em;max-inline-size:min(24rem,calc(100vw - 16px));margin:0;padding:.35em;border:1px solid var(--_border);border-radius:var(--_radius);background:var(--_raised);color:var(--_text);box-shadow:0 6px 24px rgb(0 0 0 / .18);overflow:auto;overscroll-behavior:contain}
.panel.inline{position:absolute;inset-inline-start:0;inset-block-start:calc(100% + 4px);z-index:1}
.panel[open]{display:block}
.panel:popover-open{display:block}
.header{padding:.5em .75em;color:var(--_muted);overflow-wrap:anywhere}
.switcher{display:block;inline-size:100%;block-size:320px}
.switcher.compact{block-size:248px}
.switcher[hidden]{display:none}
[role=list]{display:block}
.item,::slotted(a),::slotted(button){display:flex;align-items:center;box-sizing:border-box;inline-size:100%;min-block-size:44px;padding:.5em .75em;border:0;border-radius:calc(var(--_radius) - 2px);background:transparent;color:var(--_text);text-align:start;text-decoration:none;font:inherit;cursor:pointer}
.item:hover,.item:focus-visible{background:var(--_surface)}
.danger{color:var(--_danger)}
.note{display:block;font-size:.85em;color:var(--_muted);padding:0 .75em .5em}
hr{border:0;border-block-start:1px solid var(--_border);margin:.35em 0}
.handle{padding:.5em .75em}
.handle label{display:block;font-weight:600;margin-block-end:.35em}
.handle .field{display:flex;gap:.5em;flex-wrap:wrap}
.handle input{flex:1;min-inline-size:8em;min-block-size:44px;box-sizing:border-box;padding:.4em .6em;border:1px solid var(--_border);border-radius:var(--_radius);background:var(--_surface);color:var(--_text);font:inherit}
@media (forced-colors:active){.panel{border-color:CanvasText;background:Canvas;color:CanvasText}.item{color:ButtonText}}
`;
const failureCodes={canceled:'canceled',dismissed:'canceled','network-error':'network-error','discovery-error':'network-error'};

export class AccountView {
  constructor(host){this.host=host;}
  #session=null;#open=false;#listeners=[];#connected=false;#unwatch=null;#reason=null;#keyboard=false;#handleMode=null;#handleError='';#pictureFailed=null;
  #reported;#reportedSubject=null;#deadline=Infinity;#switching=false;#islands={avatar:null,switcher:null};#islandStates={avatar:'off',switcher:'off'};#islandKeys={avatar:'',switcher:''};#switcherWanted=false;#dismissedAt=-Infinity;#selected=null;
  connected(){this.#connected=true;this.#unwatch=watchScheme(this.host,()=>this.render());this.render();requestSession(this.host,session=>{if(this.#connected)this.#attach(session);});}
  disconnected(){this.#connected=false;this.#unwatch?.();this.#setOpen(false,'disconnect',{restoreFocus:false});this.#detach();for(const name of ['avatar','switcher'])this.#unmount(name);}
  get session(){return this.#session;}
  get open(){return this.#open;}
  // Read-only snapshot, updated before the corresponding event (late listeners read it).
  get state(){
    const view=this.#session?.session??null;
    return Object.freeze({status:!view?'signed-out':this.#switching?'changing':'signed-in',session:view,open:this.#open,mode:view?'popover':null,islands:Object.freeze({...this.#islandStates}),actions:Object.freeze(this.#available()),capabilities:this.#session?.capabilities??null});
  }
  #attach(session){
    this.#detach();this.#session=session;
    const changed=()=>{
      const view=session.session,key=view?`${view.issuer} ${view.subject}`:'';
      if(!view)this.#setOpen(false,'session',{restoreFocus:false});
      // When sign-in completes, the slotted <bindle-sign-in> unassigns; keep focus on the trigger.
      const hadFocus=!!view&&this.host.contains(globalThis.document?.activeElement)&&globalThis.document.activeElement!==this.host;
      if(this.#reported!==undefined&&key!==this.#reported){
        const previous=this.#reportedSubject,cause=!view?(Date.now()>=this.#deadline-1000?'expired':'sign-out'):previous?'switch':'sign-in';
        this.#switching=false;this.#pictureFailed=null;this.#handleMode=null;
        emitLater(this.host,'bindle-account-change',{previous,session:view,cause});
      }
      this.#reported=key;this.#reportedSubject=view?.subject??null;
      const tokens=session.client?.session;this.#deadline=tokens?(tokens.refresh_token?tokens.refreshExpiresAt:tokens.expiresAt):Infinity;
      this.render();
      if(hadFocus)this.#trigger()?.focus();
    };
    const ended=event=>{
      if(session.flowInitiator!==this.host||!this.#switching)return;
      const {outcome,code}=event.detail;
      if(['completed','redirecting','popup-blocked'].includes(outcome))return;
      this.#switching=false;
      if(code==='identity-required'){this.#handleMode='another';this.#setOpen(true,'action');return;}
      emitLater(this.host,'bindle-account-change-failed',{code:code==='no-session'?'no-session':outcome==='network-error'&&code!=='network-error'?'exchange-failed':failureCodes[outcome]??'canceled'});
      this.render();
    };
    for(const [type,listener] of [['bindle-session-change',changed],['bindle-flow-state',()=>this.render()],['bindle-flow-end',ended],['bindle-capabilities-change',()=>this.render()]]){session.addEventListener(type,listener);this.#listeners.push([type,listener]);}
    changed();
  }
  #detach(){for(const [type,listener] of this.#listeners)this.#session?.removeEventListener(type,listener);this.#listeners=[];}
  #trigger(){return this.host.shadowRoot?.querySelector('.trigger');}
  #panel(){return this.host.shadowRoot?.querySelector('.panel');}
  // Requested actions filtered by what the session issuer can do (A7). Without a
  // known capability set only the always-available actions render.
  #available(){
    const value=this.host.getAttribute('actions'),requested=(value===null?defaultActions:value.split(/\s+/)).filter(action=>accountActions.includes(action));
    const capabilities=this.#session?.capabilities,live=this.#islandStates.switcher==='live';
    return requested.filter(action=>action==='reauth'?!!capabilities?.reauthenticate:action==='provider-sign-out'?!!capabilities?.endSession:live?!['switch','manage'].includes(action):true);
  }
  #setOpen(open,reason,{restoreFocus=true,focusInside=false}={}){
    if(this.#open===open)return;
    this.#open=open;this.#reason=null;
    const doc=this.host.ownerDocument,view=doc?.defaultView,panel=this.#panel();
    if(open){doc?.addEventListener('pointerdown',this.#onOutside,true);view?.addEventListener('resize',this.#place);view?.addEventListener('scroll',this.#place,{capture:true,passive:true});this.#wantSwitcher();}
    else{doc?.removeEventListener('pointerdown',this.#onOutside,true);view?.removeEventListener('resize',this.#place);view?.removeEventListener('scroll',this.#place,{capture:true});this.#handleError='';}
    this.render();
    if(this.#popover(panel)){try{if(open&&!panel.matches(':popover-open'))panel.showPopover({source:this.#trigger()});else if(!open&&panel.matches(':popover-open'))panel.hidePopover();}catch{}}
    if(open){this.#place();if(focusInside)(panel?.querySelector('input,button,a[href]')??panel)?.focus({preventScroll:true});else panel?.focus?.({preventScroll:true});}
    emit(this.host,'bindle-menu-toggle',{open,reason});
    if(!open&&restoreFocus)this.#trigger()?.focus();
  }
  #popover(panel){return !!panel&&typeof panel.showPopover==='function'&&panel.hasAttribute('popover');}
  // Popover state changes the element did not request (light dismiss, Escape).
  #onToggle=event=>{
    const open=event.newState==='open';if(open===this.#open)return;
    const reason=this.#reason??(open?'trigger':'outside');this.#reason=null;
    if(!open)this.#dismissedAt=globalThis.performance?.now?.()??Date.now();
    this.#setOpen(open,reason,{restoreFocus:reason==='escape'});
  };
  #onOutside=event=>{if(!event.composedPath().includes(this.host)&&!event.composedPath().includes(this.#panel()))this.#setOpen(false,'outside',{restoreFocus:false});};
  #onTriggerKey=event=>{if(['Enter',' ','ArrowDown'].includes(event.key)){this.#keyboard=true;if(event.key==='ArrowDown'&&!this.#open){event.preventDefault();this.#setOpen(true,'trigger',{focusInside:true});}}};
  #onTriggerClick=()=>{
    // Without invoker-aware light dismiss, a press on the trigger first dismisses the popover; never reopen it.
    if(!this.#open&&(globalThis.performance?.now?.()??Date.now())-this.#dismissedAt<300)return;
    const keyboard=this.#keyboard;this.#keyboard=false;this.#setOpen(!this.#open,'trigger',{restoreFocus:false,focusInside:keyboard});};
  #onPanelKey=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.#setOpen(false,'escape');}};
  // Focus leaving the panel closes it (CPR-20: hostile islands cannot hold it open).
  #onFocusOut=()=>setTimeout(()=>{
    if(!this.#open)return;let active=this.host.ownerDocument.activeElement;
    while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
    const panel=this.#panel();if(!active||active===this.host.ownerDocument.body||active===this.host||this.host.contains(active)||panel?.contains(active)||this.host.shadowRoot?.contains(active))return;
    this.#setOpen(false,'focus',{restoreFocus:false});
  },0);
  // Anchored placement in the top layer: below the trigger, flipped above when it fits better, kept 8px inside the viewport.
  #place=()=>{
    const panel=this.#panel(),trigger=this.#trigger(),view=this.host.ownerDocument.defaultView;
    if(!this.#open||!this.#popover(panel)||!trigger||!view)return;
    const rect=trigger.getBoundingClientRect(),width=panel.offsetWidth,height=panel.offsetHeight,below=view.innerHeight-rect.bottom-12,above=rect.top-12;
    const up=height>below&&above>below,rtl=view.getComputedStyle(this.host).direction==='rtl';
    const left=Math.min(Math.max(8,rtl?rect.right-width:rect.left),Math.max(8,view.innerWidth-width-8));
    Object.assign(panel.style,{position:'fixed',inset:'auto',insetInlineStart:'auto',left:`${left}px`,top:up?'auto':`${rect.bottom+4}px`,bottom:up?`${view.innerHeight-rect.top+4}px`:'auto',maxHeight:`${Math.max(120,up?above:below)}px`});
  };
  // Flow methods run synchronously in the click so a popup opens inside the activation.
  #start(intent,options){const session=this.#session;return session[startFlow]?session[startFlow](intent,options,this.host):({login:()=>session.signIn(options),'select-account':()=>session.switchAccount(options),reauthenticate:()=>session.reauthenticate(options),'end-session':()=>session.endProviderSession()})[intent]();}
  run(action){return this.#run(action);}
  #run(action){
    const session=this.#session;if(!session)return;
    const capabilities=session.capabilities;
    // "Use another account" without select-account or identity-optional login, and
    // "Use a different provider", need a typed handle first (CP-10).
    if(action==='provider'||action==='switch'&&capabilities&&!capabilities.selectAccount&&!capabilities.identityless){this.#handleMode=action==='provider'?'provider':'another';this.#handleError='';this.render();this.host.shadowRoot?.querySelector('.handle input')?.focus();return;}
    this.#setOpen(false,'action');
    let result;
    if(action==='switch'){this.#switching=true;result=this.#start('select-account',{revokePrevious:this.host.hasAttribute('revoke-on-switch')});}
    if(action==='reauth')result=this.#start('reauthenticate',{maxAge:Number.parseInt(this.host.getAttribute('reauth-max-age')??'300',10)||300});
    if(action==='provider-sign-out')result=this.#start('end-session',{});
    if(action==='sign-out')result=session.signOut({revoke:this.host.hasAttribute('revoke-on-sign-out')});
    if(action==='sign-in')result=this.#start('login',{});
    result?.catch?.(()=>{});
  }
  #onHandleSubmit=event=>{
    event.preventDefault();
    const t=localize(this.host).t,value=this.host.shadowRoot.querySelector('.handle input').value.trim(),session=this.#session;
    try{parseIdentity(value,session.defaultHost,{allowInsecureLocalhost:session.client?.allowInsecureLocalhost===true});}
    catch(error){this.#handleError=value?t(error.message):t('Enter your Bindle identity.');this.render();return;}
    this.#handleMode=null;this.#setOpen(false,'action');this.#switching=true;
    this.#start('select-account',{identity:value,revokePrevious:this.host.hasAttribute('revoke-on-switch')})?.catch?.(()=>{});
  };
  // ---- Island hook (avatar on sign-in, switcher on first intent) ----
  #wantSwitcher=()=>{if(!this.#switcherWanted){this.#switcherWanted=true;this.render();}};
  #syncIsland(name,part,selector,wanted){
    const spec=wanted?islandPart(this.#session,part):null,key=spec?`${spec.issuer} ${spec.version}`:'';
    if(key===this.#islandKeys[name])return;this.#islandKeys[name]=key;this.#unmount(name);
    if(!spec)return;
    queueMicrotask(async()=>{
      const container=this.host.shadowRoot?.querySelector(selector);if(!container||this.#islandKeys[name]!==key)return;
      const island=await mountIsland(this.host,{part,container,session:this.#session,onState:state=>{if(this.#islandKeys[name]===key){this.#islandStates[name]=state;this.render();}}});
      // A mount that finished after its key changed or the element disconnected is discarded.
      if(this.#islandKeys[name]!==key||!this.#connected)island?.destroy();else this.#islands[name]=island;
    });
  }
  #unmount(name){try{this.#islands[name]?.destroy?.();}catch{}this.#islands[name]=null;if(this.#islandStates[name]!=='fallback')this.#islandStates[name]='off';}
  // Called by the island mounter for the switcher's `select` (profile §5.4): only a
  // held app session for exactly that subject is ever made current.
  islandSelect(subject){
    // Repeats for the same subject within 500 ms are one selection (embed-islands §10.2).
    const now=globalThis.performance?.now?.()??Date.now();if(subject===this.#selected?.subject&&now-this.#selected.at<500)return;this.#selected={subject,at:now};
    const result=this.#session?.controller?.selectAccount?.(subject)??{outcome:'canceled',code:'no-session'};
    this.#setOpen(false,'select');
    if(result.outcome==='completed')emitLater(this.host,'bindle-account-select',{subject});
    else emitLater(this.host,'bindle-account-change-failed',{code:'no-session'});
  }
  islandClose(reason='escape'){this.#setOpen(false,reason==='dismiss'?'action':'escape');}
  // The switcher's "Use another account" (profile §5.4). `completed` arrives after the app's exchange settled, so the
  // controller's session change (bindle-account-change) has already been dispatched; failures keep the session.
  islandFlow(phase,outcome,code){
    if(phase==='started'){this.#switching=true;this.render();return;}
    if(phase!=='ended'||!this.#switching)return;
    this.#switching=false;
    if(outcome!=='completed')emitLater(this.host,'bindle-account-change-failed',{code:outcome==='network-error'?(code==='network-error'?'network-error':'exchange-failed'):'canceled'});
    this.render();
  }
  render(){
    if(!this.#connected)return;
    const {t,direction}=localize(this.host),session=this.#session,view=session?.session,flow=session?.flow,mine=session?.flowInitiator===this.host;
    const {theme,colorScheme}=schemeFor(this.host,session),win=this.host.ownerDocument.defaultView;
    // Island containers are keyed and stay in place across sign-in and sign-out, so mounted islands live as long as
    // the element is connected (embed-islands §8.2): on app sign-out they still receive session{null} and `forget`.
    // The iframe goes into a constant inner host: dodo replaces the children of any node whose vnode changed, so only
    // the outer box may toggle `hidden`.
    const avatarBox=h('span',h('span').classes('island-host')).classes('avatar-island').attrs({part:'avatar-frame','aria-hidden':'true'}).props({hidden:!view}).key('avatar-frame');
    // Fixed island height by density (profile §6: 320 or 248 CSS px), an embedder-side input only.
    const switcherBox=h('div',h('div').classes('island-host')).classes('switcher',this.host.getAttribute('density')==='compact'&&'compact').attrs({part:'switcher-frame'}).props({hidden:!view||this.#islandStates.switcher!=='live'}).key('switcher-frame');
    let body;
    if(!view){
      body=[h('slot',h('button',t('Sign in')).props({type:'button'}).classes('primary').attrs({part:'sign-in'}).on({click:()=>this.#run('sign-in')})).attrs({name:'signed-out'}),
        (this.#islandKeys.avatar||this.#islandKeys.switcher)&&h('div',avatarBox,h('dialog',switcherBox).props({id:'panel'}).classes('panel')).classes('wrap').props({hidden:true}).key('wrap')];
    } else {
      const capabilities=session.capabilities,host=new URL(view.issuer).host,name=view.profile?.displayName??view.profile?.handle,label=name??t('Signed in · {host}',{host});
      const model=avatarModel(view,{pictureFailed:this.#pictureFailed===view.profile?.picture});
      const actions=this.#available(),avatarOnly=this.host.getAttribute('trigger')==='avatar';
      const item=(action,text,danger,extra)=>h('div',h('button',text).props({type:'button'}).attrs(attrs({part:danger?'item item-danger':'item',...extra})).classes('item',danger&&'danger').on({click:()=>this.#run(action)})).attrs({role:'listitem'});
      const labels={switch:t('Use another account'),provider:t('Use a different provider'),reauth:t("Confirm it's you"),'sign-out':t('Sign out of this app'),'provider-sign-out':t('Sign out of {host}…',{host})};
      const items=actions.map(action=>{
        if(action==='manage')return h('div',h('a',t('Manage at {host}',{host})).attrs({part:'item',href:capabilities?.manageUrl??view.issuer+'/',target:'_blank',rel:'noopener noreferrer'}).classes('item')).attrs({role:'listitem'});
        if(action==='provider-sign-out')return item(action,labels[action],true,{'aria-describedby':'provider-note'});
        return item(action,labels[action],false);
      });
      const note=actions.includes('provider-sign-out')&&h('span',t('Other apps and accounts stay signed in unless you choose otherwise at {host}.',{host})).props({id:'provider-note'}).classes('note');
      const popover=typeof win?.HTMLElement?.prototype?.showPopover==='function';
      const handle=this.#handleMode&&h('form',
        h('label',this.#handleMode==='provider'?t('Use a different provider'):t('Your Bindle identity')).attrs({for:'switch-handle'}),
        h('div',h('input').props({id:'switch-handle'}).attrs(attrs({name:'identity',autocomplete:'username',autocapitalize:'none',spellcheck:'false',inputmode:'email',part:'input','aria-invalid':this.#handleError?'true':undefined,'aria-describedby':this.#handleError?'switch-error':undefined})),h('button',t('Continue')).attrs({type:'submit',part:'submit'}).classes('primary')).classes('field'),
        h('p',this.#handleError).props({id:'switch-error'}).attrs({role:'alert'}).classes('error'),
      ).classes('handle').attrs({part:'handle-form',novalidate:''}).on({submit:this.#onHandleSubmit});
      body=[h('div',
        h('button',
          h('span',h('slot',avatarView(model,{onPictureError:()=>{this.#pictureFailed=view.profile?.picture;this.render();}})).attrs({name:'badge'})).classes('avatar-box'),
          h('bdi',label).classes('label',avatarOnly&&'visually-hidden').attrs({part:'label',dir:'auto'}),
        ).props({type:'button'}).classes('trigger',avatarOnly&&'avatar-only').attrs({part:'trigger badge','aria-haspopup':'dialog','aria-expanded':String(this.#open),'aria-controls':'panel','aria-label':t('Account: {name}',{name:label})}).on({click:this.#onTriggerClick,keydown:this.#onTriggerKey,pointerenter:this.#wantSwitcher,focus:this.#wantSwitcher}),
        avatarBox,
        h('dialog',
          h('div',h('slot',h('bdi',label).attrs({dir:'auto'})).attrs({name:'menu-header'})).classes('header').attrs({part:'menu-header'}),
          switcherBox,
          h('div',
            h('div',h('slot').attrs({name:'menu-start'})).attrs({role:'listitem'}),
            ...items,
            this.host.querySelector(':scope > [slot=menu-end]')&&h('hr').attrs({part:'separator','aria-hidden':'true'}),
            h('div',h('slot').attrs({name:'menu-end'})).attrs({role:'listitem'}),
          ).attrs({role:'list',part:'menu','aria-label':t('Account actions')}),
          handle,note,
          h('slot').attrs({name:'panel-footer'}),
        ).props({id:'panel',tabIndex:-1,...popover?{}:{open:this.#open}}).classes('panel',!popover&&'inline').attrs(attrs({part:'panel','aria-label':t('Account'),popover:popover?'auto':undefined})).on({toggle:this.#onToggle,keydown:this.#onPanelKey,focusout:this.#onFocusOut}),
      ).classes('wrap').attrs({part:'wrap'}).key('wrap')];
    }
    reconcileShadow(this.host,[h('div',...body,h('p',(mine&&flowStatus(flow,t))||'').attrs({role:'status',part:'status'}).classes('status'),mine&&flowNotice(flow,t,session)).classes('root',theme).attrs({dir:direction}).style(colorScheme?{'color-scheme':colorScheme}:{})],[baseStyles(win),avatarStyles(win),styles(win)]);
    this.#syncIsland('avatar','avatar','.avatar-island > .island-host',(!!view||!!this.#islandKeys.avatar)&&!this.host.querySelector(':scope > [slot=badge]'));
    this.#syncIsland('switcher','account-switcher','.switcher > .island-host',(!!view||!!this.#islandKeys.switcher)&&this.#switcherWanted);
    for(const island of Object.values(this.#islands))island?.refresh?.();
  }
}

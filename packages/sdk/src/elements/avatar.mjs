// <bindle-avatar>: the current app session's identity picture (decision note
// §6.3). Always the standard avatar chain (granted picture → initials → subject
// monogram); with a declared avatar island, the transparent island is layered
// over it and covers it only with a bound picture. No events.
import {ElementBase,h,islandPart,localize,mountIsland,reconcileShadow,requestSession,schemeFor,watchScheme} from './shared.mjs';
import {css} from '../../../../vendor/dodo/style.js';

export class BindleAvatarElement extends ElementBase {
  static observedAttributes=['lang','theme','size','label'];
  #session=null;#connected=false;#listeners=[];#unwatch=null;#island=null;#islandState='off';#islandKey='';#pictureFailed=null;#source='monogram';#views=null;
  connectedCallback(){this.#connected=true;this.#unwatch=watchScheme(this,()=>this.render());this.render();requestSession(this,session=>{if(this.#connected)this.#attach(session);});}
  disconnectedCallback(){this.#connected=false;this.#unwatch?.();for(const [type,listener] of this.#listeners)this.#session?.removeEventListener(type,listener);this.#listeners=[];this.#unmount();}
  attributeChangedCallback(){if(this.#connected)this.render();}
  // `source` reflects only what the element itself rendered ('island' while an island is live).
  get state(){return Object.freeze({islands:this.#islandState,source:this.#islandState==='live'?'island':this.#source});}
  // Re-evaluates the effective scheme after an embedder theme change the element cannot observe.
  refreshTheme(){if(this.isConnected)this.render();}
  #attach(session){
    this.#session=session;const rerender=()=>this.render();
    for(const type of ['bindle-session-change','bindle-capabilities-change']){session.addEventListener(type,rerender);this.#listeners.push([type,rerender]);}
    this.render();
  }
  #unmount(){try{this.#island?.destroy?.();}catch{}this.#island=null;this.#islandState='off';}
  render(){
    if(!this.#connected)return;
    const {t}=localize(this),session=this.#session,view=session?.session,win=this.ownerDocument.defaultView,size=Number.parseInt(this.getAttribute('size')??'',10);
    // The avatar view loads with the first session (fresh pages are always signed out).
    if(view&&!this.#views){import('./avatar-view.mjs').then(module=>{this.#views=module;this.render();});return;}
    const {theme,colorScheme}=schemeFor(this,session),{avatarModel,avatarStyles,avatarView}=this.#views??{};
    const model=view&&avatarModel(view,{pictureFailed:this.#pictureFailed===view.profile?.picture});this.#source=model?.source??'monogram';
    reconcileShadow(this,[h('span',
      model?avatarView(model,{label:this.getAttribute('label')||t('Identity picture'),onPictureError:()=>{this.#pictureFailed=view.profile?.picture;this.render();}}):null,
      h('span').classes('island').attrs({part:'avatar-frame','aria-hidden':'true'}),
    ).classes('root',theme).style({...colorScheme?{'color-scheme':colorScheme}:{},...size>=16&&size<=512?{'--bindle-avatar-size':`${size}px`}:{}})],[...avatarStyles?[avatarStyles(win)]:[],css.in(win)`:host{display:inline-block}.root{position:relative;display:inline-grid}.island{position:absolute;inset:0;pointer-events:none}.island:empty{display:none}`]);
    const spec=view?islandPart(session,'avatar'):null,key=spec?`${spec.issuer} ${spec.version}`:'';
    if(key!==this.#islandKey){this.#islandKey=key;this.#unmount();if(spec)queueMicrotask(async()=>{const container=this.shadowRoot?.querySelector('.island');if(container&&this.#islandKey===key)this.#island=await mountIsland(this,{part:'avatar',container,session,onState:state=>{this.#islandState=state;}});});}
  }
}

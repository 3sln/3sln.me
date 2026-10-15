// <bindle-account>: the composed profile button (decision note §6.2, CP-8). This
// host element is all define.mjs carries; the implementation (AccountView in
// account-view.mjs: dialog container, capability-driven actions, standard
// avatar, island hook, events) loads on connect. Until then the element shows
// its signed-out slot, the only state a fresh page can be in (app sessions are
// memory-only).
import {ElementBase,baseStyles,h,localize,reconcileShadow} from './shared.mjs';

export const accountActions=Object.freeze(['switch','provider','reauth','sign-out','provider-sign-out','manage']);
const signedOut=Object.freeze({status:'signed-out',session:null,open:false,mode:null,islands:Object.freeze({avatar:'off',switcher:'off'}),actions:Object.freeze([]),capabilities:null});

export class BindleAccountElement extends ElementBase {
  static observedAttributes=['actions','lang','theme','trigger','density'];
  #view=null;#loading=null;#connected=false;
  connectedCallback(){
    this.#connected=true;
    if(this.#view)return this.#view.connected();
    reconcileShadow(this,[h('div',h('slot',h('button',localize(this).t('Sign in')).props({type:'button'}).classes('primary').attrs({part:'sign-in'}).on({click:()=>this.#loading?.then(()=>this.#view?.run('sign-in'))})).attrs({name:'signed-out'})).classes('root','auto')],[baseStyles(this.ownerDocument.defaultView)]);
    this.#loading??=import('./account-view.mjs').then(({AccountView})=>{this.#view=new AccountView(this);if(this.#connected)this.#view.connected();});
  }
  disconnectedCallback(){this.#connected=false;this.#view?.disconnected();}
  attributeChangedCallback(){if(this.#connected)this.#view?.render();}
  // Re-evaluates the effective scheme after an embedder theme change the element cannot observe.
  refreshTheme(){if(this.isConnected)this.#view?.render();}
  get session(){return this.#view?.session??null;}
  get open(){return this.#view?.open??false;}
  // Read-only snapshot, updated before the corresponding event (late listeners read it).
  get state(){return this.#view?.state??signedOut;}
  // Called by the island mounter (components profile §5.4).
  islandSelect(subject){this.#view?.islandSelect(subject);}
  islandClose(reason){this.#view?.islandClose(reason);}
  islandFlow(phase,outcome){this.#view?.islandFlow(phase,outcome);}
}
